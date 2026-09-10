import type { AIConfig } from '../shared/types';
import { appError } from '../shared/errors';

export interface ConfigStorage {
  get(keys?: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export const DEFAULT_CONFIG: AIConfig = {
  baseUrl: '',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.2,
  timeout: 30000,
  autoSubmit: false,
  autoSolve: false,
  autoAdvanceVideo: false
};

const configKeys = [
  'baseUrl',
  'apiKey',
  'model',
  'temperature',
  'timeout',
  'autoSubmit',
  'autoSolve',
  'autoAdvanceVideo'
];

function readConfigValue(stored: Record<string, unknown>): AIConfig {
  return {
    baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : DEFAULT_CONFIG.baseUrl,
    apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : DEFAULT_CONFIG.apiKey,
    model: typeof stored.model === 'string' ? stored.model : DEFAULT_CONFIG.model,
    temperature: typeof stored.temperature === 'number'
      ? stored.temperature
      : DEFAULT_CONFIG.temperature,
    timeout: typeof stored.timeout === 'number' ? stored.timeout : DEFAULT_CONFIG.timeout,
    autoSubmit: typeof stored.autoSubmit === 'boolean'
      ? stored.autoSubmit
      : DEFAULT_CONFIG.autoSubmit,
    autoSolve: typeof stored.autoSolve === 'boolean'
      ? stored.autoSolve
      : DEFAULT_CONFIG.autoSolve,
    autoAdvanceVideo: typeof stored.autoAdvanceVideo === 'boolean'
      ? stored.autoAdvanceVideo
      : DEFAULT_CONFIG.autoAdvanceVideo
  };
}

export async function loadConfig(
  storage: ConfigStorage = chrome.storage.local
): Promise<AIConfig> {
  return readConfigValue(await storage.get(configKeys));
}

export function validateConfig(config: AIConfig): void {
  if (!config.baseUrl.trim() || !config.apiKey.trim() || !config.model.trim()) {
    throw appError('AI_CONFIG_INVALID', 'AI 配置无效：Base URL、API Key 和 Model 不能为空');
  }

  try {
    new URL(config.baseUrl);
  } catch {
    throw appError('AI_CONFIG_INVALID', 'AI 配置无效：Base URL 不是有效地址');
  }

  if (!Number.isFinite(config.temperature) || config.temperature < 0) {
    throw appError('AI_CONFIG_INVALID', 'AI 配置无效：Temperature 必须是非负数字');
  }

  if (!Number.isInteger(config.timeout) || config.timeout <= 0) {
    throw appError('AI_CONFIG_INVALID', 'AI 配置无效：Timeout 必须是正整数');
  }
}

export async function saveConfig(
  storage: ConfigStorage,
  config: AIConfig
): Promise<void> {
  validateConfig(config);
  await storage.set({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature,
    timeout: config.timeout,
    autoSubmit: config.autoSubmit,
    autoSolve: config.autoSolve,
    autoAdvanceVideo: config.autoAdvanceVideo
  });
}
