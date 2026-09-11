import { findAdapter } from '../adapters';
import { loadConfig } from '../background/config';
import { appError, AppErrorException } from '../shared/errors';
import { isExtensionMessage } from '../shared/messages';
import type { ExtensionMessage } from '../shared/messages';
import type { AppError, PageContext } from '../shared/types';
import type { SiteAdapter } from '../adapters/base';
import { createDebouncedScanner, scanPage } from './scanner';
import { fillCodeInPage, readCodeInPage } from './injected-bridge';

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

function injectPageContext(): Promise<void> {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  const ready = new Promise<void>((resolve) => {
    const finish = (): void => {
      script.remove();
      resolve();
    };
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', finish, { once: true });
  });
  (document.head ?? document.documentElement).appendChild(script);
  return ready;
}

const disabledPageContext: PageContext = {
  adapter: 'none',
  supported: false,
  hasVideo: false,
  hasEditor: false
};
let pluginEnabled = true;
const pluginStateReady = loadConfig()
  .then((config) => {
    pluginEnabled = config.enabled;
  })
  .catch(() => undefined);
let pageContextReady: Promise<void> | undefined;
const fillCode = (code: string, signal?: AbortSignal) => signal
  ? fillCodeInPage(code, window, undefined, signal)
  : fillCodeInPage(code, window);
const readCode = (signal?: AbortSignal) => signal
  ? readCodeInPage(window, undefined, signal)
  : readCodeInPage(window);
let submissionWatcherStarted = false;
let submissionAdapter: SiteAdapter | undefined;
let solveGeneration = 0;
let projectContextCollecting = false;
let projectScanController: AbortController | undefined;
let fillController: AbortController | undefined;
let pageScanGeneration = 0;

function ensurePageContextReady(): Promise<void> {
  pageContextReady ??= injectPageContext();
  return pageContextReady;
}

function ensureSubmissionWatcher(): void {
  if (submissionWatcherStarted) return;
  const adapter = findAdapter(document, window.location, fillCode);
  if (!adapter?.watchSubmissionResult) return;

  adapter.watchSubmissionResult();
  submissionAdapter = adapter;
  submissionWatcherStarted = true;
}

const scan = () => {
  if (!pluginEnabled) return disabledPageContext;
  ensureSubmissionWatcher();
  return scanPage(document, window.location, fillCode);
};

function scanWithoutProjectFiles(): ReturnType<typeof scan> {
  if (!pluginEnabled) return disabledPageContext;
  const context = scan();
  if (context.question?.type !== 'project') return context;
  const { question: _question, ...withoutQuestion } = context;
  return { ...withoutQuestion, supported: false };
}

let projectContextPromise: Promise<ReturnType<typeof scan>> | undefined;
const emitPageContext = (context: ReturnType<typeof scan>) => {
  void chrome.runtime.sendMessage({ type: 'PAGE_CONTEXT', data: context }).catch(() => undefined);
};

function abortActivePageWork(): void {
  solveGeneration += 1;
  projectScanController?.abort();
  fillController?.abort();
  projectContextPromise = undefined;
}

function scanWithProjectFiles(): Promise<ReturnType<typeof scan>> {
  if (!pluginEnabled) return Promise.resolve(disabledPageContext);
  if (projectContextPromise) return projectContextPromise;

  const adapter = findAdapter(document, window.location, fillCode, readCode);
  if (!adapter?.extractQuestionAsync || adapter.detectQuestionType() !== 'project') {
    return Promise.resolve(scan());
  }

  const controller = new AbortController();
  projectScanController = controller;
  projectContextCollecting = true;
  const projectRunPromise = (async () => {
    await ensurePageContextReady();
    if (!pluginEnabled || controller.signal.aborted) return disabledPageContext;
    const question = await adapter.extractQuestionAsync!(controller.signal);
    if (!pluginEnabled || controller.signal.aborted) return disabledPageContext;
    const context = scan();
    return question ? { ...context, question, supported: true } : context;
  })();
  projectContextPromise = projectRunPromise
    .finally(() => {
      if (projectScanController !== controller) return;
      projectContextCollecting = false;
      projectScanController = undefined;
      projectContextPromise = undefined;
    });
  return projectContextPromise;
}

async function scanForEmit(): Promise<ReturnType<typeof scan>> {
  const scanGeneration = pageScanGeneration;
  try {
    await pluginStateReady;
    if (!pluginEnabled) return disabledPageContext;
    void ensurePageContextReady();
    const context = await scanWithProjectFiles();
    return scanGeneration === pageScanGeneration ? context : scanForEmit();
  } catch {
    return scanGeneration === pageScanGeneration
      ? scanWithoutProjectFiles()
      : scanForEmit();
  }
}

function stopSubmissionWatcher(): void {
  submissionAdapter?.stopSubmissionResultWatcher?.();
  submissionAdapter = undefined;
  submissionWatcherStarted = false;
}

function setPluginEnabled(enabled: boolean): void {
  if (pluginEnabled === enabled) return;
  pluginEnabled = enabled;
  pageScanGeneration += 1;
  if (!enabled) {
    abortActivePageWork();
    stopSubmissionWatcher();
    emitPageContext(disabledPageContext);
    return;
  }

  void scanForEmit().then(emitPageContext);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || typeof changes.enabled?.newValue !== 'boolean') return;
  setPluginEnabled(changes.enabled.newValue);
});

void scanForEmit().then(emitPageContext);

const scheduleScan = createDebouncedScanner(scanForEmit, emitPageContext, 300);
const observer = new MutationObserver(() => {
  if (pluginEnabled && !projectContextCollecting) scheduleScan();
});
observer.observe(document.body, { childList: true, subtree: true });
window.addEventListener('popstate', () => {
  if (pluginEnabled) scheduleScan();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isExtensionMessage(message)) return;

  if (message.type === 'GET_PAGE_CONTEXT') {
    void pluginStateReady.then(() => scanWithProjectFiles())
      .then((context) => sendResponse({ type: 'PAGE_CONTEXT', data: context } satisfies ExtensionMessage))
      .catch(() => sendResponse({
        type: 'PAGE_CONTEXT',
        data: scanWithoutProjectFiles()
      } satisfies ExtensionMessage));
    return true;
  }

  if (message.type === 'GET_PAGE_ANSWER') {
    if (!pluginEnabled) {
      sendResponse({ type: 'PAGE_ANSWER' } satisfies ExtensionMessage);
      return;
    }
    const adapter = findAdapter(document, window.location, fillCode, readCode);
    if (!adapter?.extractAnswer) {
      sendResponse({ type: 'PAGE_ANSWER' } satisfies ExtensionMessage);
      return;
    }

    void adapter.extractAnswer()
      .then((answer) => sendResponse({
        type: 'PAGE_ANSWER',
        ...(answer ? { answer } : {})
      } satisfies ExtensionMessage))
      .catch(() => sendResponse({ type: 'PAGE_ANSWER' } satisfies ExtensionMessage));
    return true;
  }

  if (message.type === 'STOP_SOLVING') {
    abortActivePageWork();
    sendResponse({ type: 'STOP_SOLVING_RESULT', success: true } satisfies ExtensionMessage);
    return;
  }

  if (message.type === 'ADVANCE_VIDEO') {
    if (!pluginEnabled) {
      sendResponse({
        type: 'VIDEO_RESULT',
        success: false,
        error: appError('PLUGIN_DISABLED', '插件已关闭')
      } satisfies ExtensionMessage);
      return;
    }
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

  if (message.type === 'SKIP_INFO_PAGE') {
    if (!pluginEnabled) {
      sendResponse({
        type: 'INFO_PAGE_RESULT',
        success: false,
        error: appError('PLUGIN_DISABLED', '插件已关闭')
      } satisfies ExtensionMessage);
      return;
    }
    const adapter = findAdapter(document, window.location, fillCode);
    if (!adapter?.skipInformationalPage) {
      sendResponse({
        type: 'INFO_PAGE_RESULT',
        success: false,
        error: appError('PAGE_NOT_SUPPORTED', '当前页面不是可跳过的信息页')
      } satisfies ExtensionMessage);
      return;
    }

    try {
      adapter.skipInformationalPage();
      sendResponse({ type: 'INFO_PAGE_RESULT', success: true } satisfies ExtensionMessage);
    } catch (error) {
      sendResponse({
        type: 'INFO_PAGE_RESULT',
        success: false,
        error: toAppError(error, appError('PAGE_NOT_SUPPORTED', '信息页跳过失败'))
      } satisfies ExtensionMessage);
    }
    return;
  }

  if (message.type !== 'FILL_ANSWER') return;

  if (!pluginEnabled) {
    sendResponse({
      type: 'FILL_RESULT',
      success: false,
      error: appError('PLUGIN_DISABLED', '插件已关闭')
    } satisfies ExtensionMessage);
    return;
  }

  const adapter = findAdapter(document, window.location, fillCode, readCode);
  if (!adapter) {
    sendResponse({
      type: 'FILL_RESULT',
      success: false,
      error: appError('PAGE_NOT_SUPPORTED', '当前页面不受支持')
    } satisfies ExtensionMessage);
    return;
  }

  const currentSolveGeneration = solveGeneration;
  fillController?.abort();
  const controller = new AbortController();
  fillController = controller;
  const isStopped = () => currentSolveGeneration !== solveGeneration
    || controller.signal.aborted
    || !pluginEnabled;
  const projectAnswerFilling = message.answer.type === 'project';
  if (projectAnswerFilling) projectContextCollecting = true;

  void adapter.fillAnswer(message.answer, {
    allowOverwrite: message.source === 'page',
    signal: controller.signal
  })
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
    .catch(async (error: unknown) => {
      const errorValue = toAppError(error);
      if (isStopped()) {
        sendResponse({ type: 'FILL_RESULT', success: false } satisfies ExtensionMessage);
        return;
      }
      if (message.source === 'page'
        && projectAnswerFilling
        && errorValue.code !== 'PLUGIN_DISABLED'
        && adapter.restoreOriginalProjectFiles) {
        try {
          await adapter.restoreOriginalProjectFiles();
        } catch (restoreError) {
          sendResponse({
            type: 'FILL_RESULT',
            success: false,
            error: toAppError(
              restoreError,
              appError('EDITOR_WRITE_FAILED', '官方答案失败后恢复原代码失败，请手动检查')
            )
          } satisfies ExtensionMessage);
          return;
        }
      }
      sendResponse({
        type: 'FILL_RESULT',
        success: false,
        error: errorValue
      } satisfies ExtensionMessage);
    })
    .finally(() => {
      if (fillController === controller) fillController = undefined;
      if (projectAnswerFilling) projectContextCollecting = false;
    });
  return true;
});
