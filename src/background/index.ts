import { askAI, testAIConnection } from './ai-client';
import { enableSidePanelOnAction } from './action';
import { loadConfig } from './config';
import { createMessageHandler } from './message-handler';
import { isExtensionMessage } from '../shared/messages';
import type { ExtensionMessage } from '../shared/messages';

void enableSidePanelOnAction(chrome.sidePanel).catch((error: unknown) => {
  console.error('[ai-learning-assistant] unable to configure side panel action', error);
});

async function getActiveTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  return typeof tabId === 'number' ? tabId : null;
}

const handler = createMessageHandler({
  askAI: (question, config, signal) => askAI(question, config, fetch, signal),
  testAIConnection,
  getConfig: () => loadConfig(),
  getActiveTabId,
  reloadTab: (tabId) => chrome.tabs.reload(tabId),
  sendToTab: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  sendStatus: (message) => {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isExtensionMessage(message)) return;

  void handler(message, sender)
    .then((result) => sendResponse(result))
    .catch(() => sendResponse({
      filled: false,
      error: { code: 'AI_REQUEST_FAILED', message: '扩展消息处理失败' }
    } satisfies Record<string, unknown>));
  return true;
});
