import type {
  AIAnswer,
  AppError,
  ChoiceOption,
  ExampleCase,
  PageContext,
  Question,
  TaskStatus
} from './types';

export type ExtensionMessage =
  | { type: 'GET_PAGE_CONTEXT' }
  | { type: 'PAGE_CONTEXT'; data: PageContext }
  | { type: 'REFRESH_PAGE' }
  | { type: 'REFRESH_PAGE_RESULT'; success: boolean; error?: AppError }
  | { type: 'STOP_SOLVING' }
  | { type: 'STOP_SOLVING_RESULT'; success: boolean }
  | { type: 'SOLVE_QUESTION'; question: Question; questionKey?: string }
  | { type: 'TEST_CONNECTION' }
  | { type: 'TEST_CONNECTION_RESULT'; success: boolean; error?: AppError }
  | { type: 'ADVANCE_VIDEO' }
  | { type: 'AI_RESULT'; answer: AIAnswer; questionKey?: string }
  | { type: 'FILL_ANSWER'; answer: AIAnswer; autoSubmit?: boolean }
  | { type: 'FILL_RESULT'; success: boolean; error?: AppError }
  | { type: 'VIDEO_RESULT'; success: boolean; error?: AppError }
  | { type: 'STATUS'; status: TaskStatus; error?: AppError; questionKey?: string };

type RecordValue = Record<string, unknown>;

const sensitiveKeys = new Set([
  'apikey',
  'authorization',
  'cookie',
  'localstorage',
  'token'
]);

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (!isRecord(value)) return false;

  return Object.entries(value).some(([key, nested]) => {
    return sensitiveKeys.has(key.toLowerCase()) || containsSensitiveKey(nested);
  });
}

function isExampleCase(value: unknown): value is ExampleCase {
  if (!isRecord(value)) return false;
  return (value.input === undefined || typeof value.input === 'string')
    && (value.output === undefined || typeof value.output === 'string');
}

function isChoiceOption(value: unknown): value is ChoiceOption {
  return isRecord(value)
    && typeof value.key === 'string'
    && value.key.trim().length > 0
    && typeof value.text === 'string';
}

function isQuestion(value: unknown): value is Question {
  if (!isRecord(value)) return false;
  if (value.type !== 'programming' && value.type !== 'choice'
    && value.type !== 'fill' && value.type !== 'unknown') {
    return false;
  }
  if (typeof value.content !== 'string') return false;
  if (value.id !== undefined && typeof value.id !== 'string') return false;
  if (value.title !== undefined && typeof value.title !== 'string') return false;
  if (value.language !== undefined && typeof value.language !== 'string') return false;
  if (value.editorCode !== undefined && typeof value.editorCode !== 'string') return false;
  if (value.selectionMode !== undefined
    && value.selectionMode !== 'single'
    && value.selectionMode !== 'multiple') {
    return false;
  }
  if (value.options !== undefined
    && (!Array.isArray(value.options) || !value.options.every(isChoiceOption))) {
    return false;
  }
  if (value.blankCount !== undefined
    && (typeof value.blankCount !== 'number'
      || !Number.isInteger(value.blankCount)
      || value.blankCount <= 0)) {
    return false;
  }
  if (value.type === 'choice') {
    return value.selectionMode !== undefined
      && Array.isArray(value.options)
      && value.options.length > 0;
  }
  if (value.type === 'fill') {
    return value.blankCount !== undefined
      && value.editorCode !== undefined
      && value.editorCode.trim().length > 0;
  }
  return value.examples === undefined
    || (Array.isArray(value.examples) && value.examples.every(isExampleCase));
}

function isAIAnswer(value: unknown): value is AIAnswer {
  if (!isRecord(value)) return false;
  if (value.type === 'programming') {
    return typeof value.code === 'string' && value.code.trim().length > 0;
  }
  if (value.type === 'fill') {
    return Array.isArray(value.values)
      && value.values.length > 0
      && value.values.every((item) => typeof item === 'string');
  }
  return value.type === 'choice'
    && Array.isArray(value.selections)
    && value.selections.length > 0
    && value.selections.every((selection) => (
      typeof selection === 'string' && selection.trim().length > 0
    ));
}

function isAppError(value: unknown): value is AppError {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
    return false;
  }

  const validCodes = new Set([
    'PAGE_NOT_SUPPORTED',
    'QUESTION_NOT_FOUND',
    'QUESTION_TYPE_UNKNOWN',
    'EDITOR_NOT_FOUND',
    'EDITOR_WRITE_FAILED',
    'AI_CONFIG_INVALID',
    'AI_REQUEST_FAILED',
    'AI_RESPONSE_INVALID',
    'SUBMIT_FAILED',
    'VIDEO_ACTION_FAILED',
    'PAGE_REFRESH_FAILED'
  ]);

  return validCodes.has(value.code)
    && (value.detail === undefined || typeof value.detail === 'string');
}

function isPageContext(value: unknown): value is PageContext {
  return isRecord(value)
    && typeof value.adapter === 'string'
    && typeof value.supported === 'boolean'
    && typeof value.hasVideo === 'boolean'
    && typeof value.hasEditor === 'boolean'
    && (value.videoSrc === undefined || typeof value.videoSrc === 'string')
    && (value.question === undefined || isQuestion(value.question));
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'idle'
    || value === 'scanning'
    || value === 'requesting'
    || value === 'filling'
    || value === 'complete'
    || value === 'error';
}

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!isRecord(value) || typeof value.type !== 'string' || containsSensitiveKey(value)) {
    return false;
  }

  switch (value.type) {
    case 'GET_PAGE_CONTEXT':
      return true;
    case 'PAGE_CONTEXT':
      return isPageContext(value.data);
    case 'REFRESH_PAGE':
      return true;
    case 'REFRESH_PAGE_RESULT':
      return typeof value.success === 'boolean'
        && (value.error === undefined || isAppError(value.error));
    case 'STOP_SOLVING':
      return true;
    case 'STOP_SOLVING_RESULT':
      return typeof value.success === 'boolean';
    case 'ADVANCE_VIDEO':
      return true;
    case 'SOLVE_QUESTION':
      return isQuestion(value.question)
        && (value.questionKey === undefined || typeof value.questionKey === 'string');
    case 'TEST_CONNECTION':
      return true;
    case 'TEST_CONNECTION_RESULT':
      return typeof value.success === 'boolean'
        && (value.error === undefined || isAppError(value.error));
    case 'AI_RESULT':
      return isAIAnswer(value.answer)
        && (value.questionKey === undefined || typeof value.questionKey === 'string');
    case 'FILL_ANSWER':
      return isAIAnswer(value.answer)
        && (value.autoSubmit === undefined || typeof value.autoSubmit === 'boolean');
    case 'FILL_RESULT':
      return typeof value.success === 'boolean'
        && (value.error === undefined || isAppError(value.error));
    case 'VIDEO_RESULT':
      return typeof value.success === 'boolean'
        && (value.error === undefined || isAppError(value.error));
    case 'STATUS':
      return isTaskStatus(value.status)
        && (value.error === undefined || isAppError(value.error))
        && (value.questionKey === undefined || typeof value.questionKey === 'string');
    default:
      return false;
  }
}
