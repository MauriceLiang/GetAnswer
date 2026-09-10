interface CodeMirrorInstance {
  setValue(value: string): void;
  focus(): void;
}

interface CodeMirrorElement extends Element {
  CodeMirror?: CodeMirrorInstance;
}

function postResult(targetWindow: Window, result: Record<string, unknown>): void {
  targetWindow.postMessage({ type: 'AI_FILL_CODE_RESULT', ...result }, '*');
}

export function handlePageMessage(
  event: MessageEvent,
  document: Document,
  targetWindow: Window
): boolean {
  if (event.source !== targetWindow || event.data?.type !== 'AI_FILL_CODE') return false;

  const code = event.data.code;
  if (typeof code !== 'string' || !code.trim()) {
    postResult(targetWindow, {
      success: false,
      error: { code: 'EDITOR_WRITE_FAILED', message: '代码为空，无法写入编辑器' }
    });
    return true;
  }

  const editor = document.querySelector('.CodeMirror') as CodeMirrorElement | null;
  const codeMirror = editor?.CodeMirror;
  if (!codeMirror) {
    postResult(targetWindow, {
      success: false,
      error: { code: 'EDITOR_NOT_FOUND', message: '未找到 CodeMirror 实例' }
    });
    return true;
  }

  try {
    codeMirror.setValue(code);
    codeMirror.focus();
    postResult(targetWindow, { success: true });
  } catch {
    postResult(targetWindow, {
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
