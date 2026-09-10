import { findAdapter } from '../adapters';
import { appError, AppErrorException } from '../shared/errors';
import { isExtensionMessage } from '../shared/messages';
import type { ExtensionMessage } from '../shared/messages';
import type { AppError } from '../shared/types';
import { createDebouncedScanner, scanPage } from './scanner';
import { fillCodeInPage } from './injected-bridge';

function toAppError(
  error: unknown,
  fallback: AppError = appError('EDITOR_WRITE_FAILED', '写入编辑器失败')
): AppError {
  if (error instanceof AppErrorException) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {})
    };
  }
  return fallback;
}

function injectPageContext(): void {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.addEventListener('load', () => script.remove(), { once: true });
  script.addEventListener('error', () => script.remove(), { once: true });
  (document.head ?? document.documentElement).appendChild(script);
}

const fillCode = (code: string) => fillCodeInPage(code, window);
let submissionWatcherStarted = false;
let solveGeneration = 0;

function ensureSubmissionWatcher(): void {
  if (submissionWatcherStarted) return;
  const adapter = findAdapter(document, window.location, fillCode);
  if (!adapter?.watchSubmissionResult) return;

  adapter.watchSubmissionResult();
  submissionWatcherStarted = true;
}

const scan = () => {
  ensureSubmissionWatcher();
  return scanPage(document, window.location, fillCode);
};
const emitPageContext = (context: ReturnType<typeof scan>) => {
  void chrome.runtime.sendMessage({ type: 'PAGE_CONTEXT', data: context }).catch(() => undefined);
};

injectPageContext();
emitPageContext(scan());

const scheduleScan = createDebouncedScanner(scan, emitPageContext, 300);
const observer = new MutationObserver(scheduleScan);
observer.observe(document.body, { childList: true, subtree: true });
window.addEventListener('popstate', scheduleScan);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isExtensionMessage(message)) return;

  if (message.type === 'GET_PAGE_CONTEXT') {
    sendResponse({ type: 'PAGE_CONTEXT', data: scan() } satisfies ExtensionMessage);
    return;
  }

  if (message.type === 'STOP_SOLVING') {
    solveGeneration += 1;
    sendResponse({ type: 'STOP_SOLVING_RESULT', success: true } satisfies ExtensionMessage);
    return;
  }

  if (message.type === 'ADVANCE_VIDEO') {
    const adapter = findAdapter(document, window.location, fillCode);
    if (!adapter?.completeVideo) {
      sendResponse({
        type: 'VIDEO_RESULT',
        success: false,
        error: appError('VIDEO_ACTION_FAILED', '当前页面不支持视频自动处理')
      } satisfies ExtensionMessage);
      return;
    }

    void adapter.completeVideo()
      .then(() => sendResponse({ type: 'VIDEO_RESULT', success: true } satisfies ExtensionMessage))
      .catch((error: unknown) => sendResponse({
        type: 'VIDEO_RESULT',
        success: false,
        error: toAppError(error, appError('VIDEO_ACTION_FAILED', '视频自动处理失败'))
      } satisfies ExtensionMessage));
    return true;
  }

  if (message.type !== 'FILL_ANSWER') return;

  const adapter = findAdapter(document, window.location, fillCode);
  if (!adapter) {
    sendResponse({
      type: 'FILL_RESULT',
      success: false,
      error: appError('PAGE_NOT_SUPPORTED', '当前页面不受支持')
    } satisfies ExtensionMessage);
    return;
  }

  const currentSolveGeneration = solveGeneration;
  const isStopped = () => currentSolveGeneration !== solveGeneration;

  void adapter.fillAnswer(message.answer)
    .then(async () => {
      if (isStopped()) {
        sendResponse({ type: 'FILL_RESULT', success: false } satisfies ExtensionMessage);
        return;
      }
      if (message.autoSubmit) {
        if (!adapter.submitAnswer) {
          throw appError('SUBMIT_FAILED', '当前页面不支持自动提交');
        }
        if (isStopped()) {
          sendResponse({ type: 'FILL_RESULT', success: false } satisfies ExtensionMessage);
          return;
        }
        await adapter.submitAnswer();
      }
      if (isStopped()) {
        sendResponse({ type: 'FILL_RESULT', success: false } satisfies ExtensionMessage);
        return;
      }
      sendResponse({ type: 'FILL_RESULT', success: true } satisfies ExtensionMessage);
    })
    .catch((error: unknown) => sendResponse({
      type: 'FILL_RESULT',
      success: false,
      error: toAppError(error)
    } satisfies ExtensionMessage));
  return true;
});
