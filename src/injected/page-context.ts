interface CodeMirrorInstance {
  getValue(): string;
  setValue(value: string): void;
  focus(): void;
}

interface CodeMirrorElement extends Element {
  CodeMirror?: CodeMirrorInstance;
}

const cancelledRequestIds = new Set<string>();

function postResult(targetWindow: Window, result: Record<string, unknown>): void {
  targetWindow.postMessage({ type: 'AI_FILL_CODE_RESULT', ...result }, '*');
}

function postRequestResult(
  targetWindow: Window,
  type: 'AI_READ_CODE_RESULT' | 'AI_FILL_CODE_RESULT',
  requestId: unknown,
  result: Record<string, unknown>
): void {
  postResult(targetWindow, {
    type,
    ...(typeof requestId === 'string' ? { requestId } : {}),
    ...result
  });
}

export function handlePageMessage(
  event: MessageEvent,
  document: Document,
  targetWindow: Window
): boolean {
  if (event.source !== targetWindow) return false;

  if (event.data?.type === 'AI_CANCEL_CODE') {
    if (typeof event.data.requestId === 'string') {
      cancelledRequestIds.add(event.data.requestId);
    }
    return true;
  }

  if (event.data?.type === 'AI_READ_CODE' || event.data?.type === 'AI_FILL_CODE') {
    const requestId = event.data.requestId;
    if (typeof requestId === 'string' && cancelledRequestIds.delete(requestId)) return true;
  }

  if (event.data?.type === 'AI_READ_CODE') {
    const editor = document.querySelector('.CodeMirror') as CodeMirrorElement | null;
    const codeMirror = editor?.CodeMirror;
    if (!codeMirror) {
      postRequestResult(targetWindow, 'AI_READ_CODE_RESULT', event.data.requestId, {
        success: false,
        error: { code: 'EDITOR_NOT_FOUND', message: '未找到 CodeMirror 实例' }
      });
      return true;
    }

    try {
      postRequestResult(targetWindow, 'AI_READ_CODE_RESULT', event.data.requestId, {
        success: true,
        code: codeMirror.getValue()
      });
    } catch {
      postRequestResult(targetWindow, 'AI_READ_CODE_RESULT', event.data.requestId, {
        success: false,
        error: { code: 'EDITOR_WRITE_FAILED', message: '读取 CodeMirror 内容失败' }
      });
    }
    return true;
  }

  if (event.data?.type !== 'AI_FILL_CODE') return false;

  const code = event.data.code;
  if (typeof code !== 'string' || !code.trim()) {
    postRequestResult(targetWindow, 'AI_FILL_CODE_RESULT', event.data.requestId, {
      success: false,
      error: { code: 'EDITOR_WRITE_FAILED', message: '代码为空，无法写入编辑器' }
    });
    return true;
  }

  const editor = document.querySelector('.CodeMirror') as CodeMirrorElement | null;
  const codeMirror = editor?.CodeMirror;
  if (!codeMirror) {
    postRequestResult(targetWindow, 'AI_FILL_CODE_RESULT', event.data.requestId, {
      success: false,
      error: { code: 'EDITOR_NOT_FOUND', message: '未找到 CodeMirror 实例' }
    });
    return true;
  }

  try {
    codeMirror.setValue(code);
    codeMirror.focus();
    postRequestResult(targetWindow, 'AI_FILL_CODE_RESULT', event.data.requestId, { success: true });
  } catch {
    postRequestResult(targetWindow, 'AI_FILL_CODE_RESULT', event.data.requestId, {
      success: false,
      error: { code: 'EDITOR_WRITE_FAILED', message: 'CodeMirror 写入失败' }
    });
  }

  return true;
}

export function installPageContextBridge(
  targetWindow: Window = window,
  document: Document = targetWindow.document
): () => void {
  const listener = (event: MessageEvent) => {
    handlePageMessage(event, document, targetWindow);
  };
  targetWindow.addEventListener('message', listener);
  return () => targetWindow.removeEventListener('message', listener);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  installPageContextBridge();
}
