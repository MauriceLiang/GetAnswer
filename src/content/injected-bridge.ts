import { appError } from '../shared/errors';
import type { AppErrorCode } from '../shared/types';

const DEFAULT_BRIDGE_TIMEOUT = 2000;

function isEditorErrorCode(value: unknown): value is Extract<
  AppErrorCode,
  'EDITOR_NOT_FOUND' | 'EDITOR_WRITE_FAILED'
> {
  return value === 'EDITOR_NOT_FOUND' || value === 'EDITOR_WRITE_FAILED';
}

export function fillCodeInPage(
  code: string,
  targetWindow: Window = window,
  timeoutMs = DEFAULT_BRIDGE_TIMEOUT
): Promise<void> {
  if (!code.trim()) {
    return Promise.reject(appError('EDITOR_WRITE_FAILED', '代码为空，无法写入编辑器'));
  }

  return new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      targetWindow.removeEventListener('message', onMessage);
      if (timeout !== undefined) clearTimeout(timeout);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== targetWindow || event.data?.type !== 'AI_FILL_CODE_RESULT') return;

      cleanup();
      if (event.data.success === true) {
        resolve();
        return;
      }

      const codeFromPage = event.data.error?.code;
      const errorCode = isEditorErrorCode(codeFromPage)
        ? codeFromPage
        : 'EDITOR_WRITE_FAILED';
      reject(appError(
        errorCode,
        event.data.error?.message ?? '写入编辑器失败'
      ));
    };

    targetWindow.addEventListener('message', onMessage);
    targetWindow.postMessage({ type: 'AI_FILL_CODE', code }, '*');
    timeout = setTimeout(() => {
      cleanup();
      reject(appError('EDITOR_WRITE_FAILED', '写入编辑器超时'));
    }, timeoutMs);
  });
}
