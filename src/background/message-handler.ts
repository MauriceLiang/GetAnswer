import { isExtensionMessage } from '../shared/messages';
import type { ExtensionMessage } from '../shared/messages';
import type {
  AIAnswer,
  AIConfig,
  AppError,
  AppErrorCode,
  Question
} from '../shared/types';
import { AppErrorException, appError } from '../shared/errors';

export interface MessageHandlerDependencies {
  askAI: (
    question: Question,
    config: AIConfig,
    signal?: AbortSignal
  ) => Promise<AIAnswer>;
  testAIConnection: (config: AIConfig) => Promise<void>;
  getConfig: () => Promise<AIConfig>;
  getActiveTabId: () => Promise<number | null>;
  reloadTab: (tabId: number) => Promise<void>;
  sendToTab: (tabId: number, message: ExtensionMessage) => Promise<unknown>;
  sendStatus: (message: ExtensionMessage) => void;
}

export interface SolveResult {
  answer?: AIAnswer;
  filled: boolean;
  cancelled?: boolean;
  error?: AppError;
}

type CorrelatedMessage = Extract<ExtensionMessage, { type: 'AI_RESULT' | 'STATUS' }>;

function toAppError(
  error: unknown,
  fallbackMessage: string,
  fallbackCode: AppErrorCode = 'AI_REQUEST_FAILED'
): AppError {
  if (error instanceof AppErrorException) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {})
    };
  }

  return {
    code: fallbackCode,
    message: fallbackMessage
  };
}

function notify(dependencies: MessageHandlerDependencies, message: ExtensionMessage): void {
  try {
    dependencies.sendStatus(message);
  } catch {
    // Status delivery must not change the solve result.
  }
}

function notifyCorrelated(
  dependencies: MessageHandlerDependencies,
  message: CorrelatedMessage,
  questionKey?: string
): void {
  notify(dependencies, questionKey === undefined ? message : { ...message, questionKey });
}

function isFillResult(value: unknown): value is { success: boolean; error?: AppError } {
  return typeof value === 'object'
    && value !== null
    && 'success' in value
    && typeof value.success === 'boolean';
}

function isVideoResult(
  value: unknown
): value is { type: 'VIDEO_RESULT'; success: boolean; error?: AppError } {
  return typeof value === 'object'
    && value !== null
    && 'type' in value
    && value.type === 'VIDEO_RESULT'
    && 'success' in value
    && typeof value.success === 'boolean';
}

export function createMessageHandler(dependencies: MessageHandlerDependencies) {
  const activeSolves = new Set<{
    controller: AbortController;
    tabId: number;
  }>();
  const activeSolvePromises = new Map<string, Promise<SolveResult>>();

  return async (message: ExtensionMessage, _sender: unknown): Promise<unknown> => {
    if (message.type === 'GET_PAGE_CONTEXT') {
      const tabId = await dependencies.getActiveTabId();
      if (tabId === null) {
        return {
          type: 'PAGE_CONTEXT',
          data: { adapter: 'none', supported: false, hasVideo: false, hasEditor: false }
        } satisfies ExtensionMessage;
      }
      return dependencies.sendToTab(tabId, message);
    }

    if (message.type === 'REFRESH_PAGE') {
      const tabId = await dependencies.getActiveTabId();
      if (tabId === null) {
        return {
          type: 'REFRESH_PAGE_RESULT',
          success: false,
          error: appError('PAGE_NOT_SUPPORTED', '没有可用的活动学习页面')
        } satisfies ExtensionMessage;
      }

      try {
        await dependencies.reloadTab(tabId);
        return { type: 'REFRESH_PAGE_RESULT', success: true } satisfies ExtensionMessage;
      } catch (error) {
        return {
          type: 'REFRESH_PAGE_RESULT',
          success: false,
          error: toAppError(error, '刷新当前页面失败', 'PAGE_REFRESH_FAILED')
        } satisfies ExtensionMessage;
      }
    }

    if (message.type === 'STOP_SOLVING') {
      for (const operation of activeSolves) {
        operation.controller.abort();
        void dependencies.sendToTab(operation.tabId, message).catch(() => undefined);
      }
      return { type: 'STOP_SOLVING_RESULT', success: true } satisfies ExtensionMessage;
    }

    if (message.type === 'TEST_CONNECTION') {
      try {
        const config = await dependencies.getConfig();
        await dependencies.testAIConnection(config);
        return { type: 'TEST_CONNECTION_RESULT', success: true } satisfies ExtensionMessage;
      } catch (error) {
        return {
          type: 'TEST_CONNECTION_RESULT',
          success: false,
          error: toAppError(error, 'AI 连通性测试失败')
        } satisfies ExtensionMessage;
      }
    }

    if (message.type === 'ADVANCE_VIDEO') {
      const tabId = await dependencies.getActiveTabId();
      if (tabId === null) {
        return {
          type: 'VIDEO_RESULT',
          success: false,
          error: appError('PAGE_NOT_SUPPORTED', '没有可用的活动学习页面')
        } satisfies ExtensionMessage;
      }

      try {
        const rawResult = await dependencies.sendToTab(tabId, message);
        if (isVideoResult(rawResult)) return rawResult;
        return {
          type: 'VIDEO_RESULT',
          success: false,
          error: appError('VIDEO_ACTION_FAILED', '视频页面未返回有效结果')
        } satisfies ExtensionMessage;
      } catch (error) {
        return {
          type: 'VIDEO_RESULT',
          success: false,
          error: toAppError(error, '视频自动处理失败', 'VIDEO_ACTION_FAILED')
        } satisfies ExtensionMessage;
      }
    }

    if (message.type !== 'SOLVE_QUESTION') return undefined;

    const questionKey = message.questionKey;
    const tabId = await dependencies.getActiveTabId();
    if (tabId === null) {
      const error = appError('PAGE_NOT_SUPPORTED', '没有可用的活动学习页面');
      notifyCorrelated(dependencies, { type: 'STATUS', status: 'error', error }, questionKey);
      return { filled: false, error } satisfies SolveResult;
    }

    const solveKey = questionKey === undefined ? undefined : `${tabId}:${questionKey}`;
    const existingSolve = solveKey === undefined ? undefined : activeSolvePromises.get(solveKey);
    if (existingSolve) return existingSolve;

    const operation = { controller: new AbortController(), tabId };
    activeSolves.add(operation);

    const solvePromise = (async (): Promise<SolveResult> => {
      try {
        const config = await dependencies.getConfig();
        const answerMode = config.answerMode ?? 'hybrid';
        const pageAnswerEligible = answerMode !== 'ai'
          && (message.question.type === 'choice' || message.question.type === 'fill');
        let aiStatusSent = false;
        const notifyAIRequest = (): void => {
          if (aiStatusSent) return;
          aiStatusSent = true;
          notifyCorrelated(dependencies, { type: 'STATUS', status: 'requesting' }, questionKey);
        };

        if (pageAnswerEligible || answerMode === 'page') {
          notifyCorrelated(
            dependencies,
            { type: 'STATUS', status: 'requesting', phase: 'page-answer' },
            questionKey
          );
        } else {
          notifyAIRequest();
        }

        let question = message.question;
        let answer: AIAnswer | undefined;
        let answerSource: 'page' | 'ai' = 'ai';

        if (pageAnswerEligible) {
          try {
            const rawPageAnswer = await dependencies.sendToTab(tabId, { type: 'GET_PAGE_ANSWER' });
            if (isExtensionMessage(rawPageAnswer)
              && rawPageAnswer.type === 'PAGE_ANSWER'
              && rawPageAnswer.answer
              && rawPageAnswer.answer.type === question.type) {
              answer = rawPageAnswer.answer;
              answerSource = 'page';
            }
          } catch {
            // The page answer is an optimization; unavailable content falls back to AI.
          }
        }

        if (operation.controller.signal.aborted) {
          return { filled: false, cancelled: true } satisfies SolveResult;
        }

        if (!answer && answerMode === 'page') {
          throw appError('QUESTION_NOT_FOUND', '未读取到有效的页面答案，已暂停，请人工检查');
        }

        if (!answer) {
          if (question.type === 'project') {
            const rawContext = await dependencies.sendToTab(tabId, { type: 'GET_PAGE_CONTEXT' });
            if (!isExtensionMessage(rawContext)
              || rawContext.type !== 'PAGE_CONTEXT'
              || rawContext.data.question?.type !== 'project') {
              throw appError('QUESTION_NOT_FOUND', '无法读取项目中的全部文件');
            }
            question = rawContext.data.question;
          }
          notifyAIRequest();
          answer = await dependencies.askAI(
            question,
            config,
            operation.controller.signal
          );
        }
        if (operation.controller.signal.aborted) {
          return { filled: false, cancelled: true } satisfies SolveResult;
        }

        notifyCorrelated(dependencies, {
          type: 'AI_RESULT',
          answer,
          ...(answerSource === 'page' ? { source: 'page' as const } : {})
        }, questionKey);
        notifyCorrelated(dependencies, { type: 'STATUS', status: 'filling' }, questionKey);

        const fillAnswer = async (candidate: AIAnswer): Promise<
          { success: boolean; error?: AppError } | null
        > => {
          if (operation.controller.signal.aborted) return null;
          const rawFillResult = await dependencies.sendToTab(tabId, {
            type: 'FILL_ANSWER',
            answer: candidate,
            autoSubmit: config.autoSubmit
          });
          if (operation.controller.signal.aborted) return null;
          return isFillResult(rawFillResult)
            ? rawFillResult
            : { success: false, error: undefined };
        };

        let fillResult = await fillAnswer(answer);
        if (fillResult === null) {
          return { answer, filled: false, cancelled: true } satisfies SolveResult;
        }

        if (!fillResult.success && answerMode === 'hybrid' && answerSource === 'page'
          && fillResult.error?.code === 'SUBMIT_FAILED') {
          answerSource = 'ai';
          notifyAIRequest();
          answer = await dependencies.askAI(
            question,
            config,
            operation.controller.signal
          );
          if (operation.controller.signal.aborted) {
            return { filled: false, cancelled: true } satisfies SolveResult;
          }
          notifyCorrelated(dependencies, { type: 'AI_RESULT', answer }, questionKey);
          notifyCorrelated(dependencies, { type: 'STATUS', status: 'filling' }, questionKey);
          fillResult = await fillAnswer(answer);
          if (fillResult === null) {
            return { answer, filled: false, cancelled: true } satisfies SolveResult;
          }
        }

        if (!fillResult.success) {
          const error = fillResult.error ?? appError('EDITOR_WRITE_FAILED', '写入编辑器失败');
          notifyCorrelated(dependencies, { type: 'STATUS', status: 'error', error }, questionKey);
          return { answer, filled: false, error } satisfies SolveResult;
        }

        notifyCorrelated(dependencies, { type: 'STATUS', status: 'complete' }, questionKey);
        return { answer, filled: true } satisfies SolveResult;
      } catch (error) {
        if (operation.controller.signal.aborted) {
          return { filled: false, cancelled: true } satisfies SolveResult;
        }
        const appErrorValue = toAppError(error, 'AI 解答失败');
        notifyCorrelated(
          dependencies,
          { type: 'STATUS', status: 'error', error: appErrorValue },
          questionKey
        );
        return { filled: false, error: appErrorValue } satisfies SolveResult;
      } finally {
        activeSolves.delete(operation);
      }
    })();

    if (solveKey === undefined) return solvePromise;
    activeSolvePromises.set(solveKey, solvePromise);
    return solvePromise.finally(() => {
      if (activeSolvePromises.get(solveKey) === solvePromise) {
        activeSolvePromises.delete(solveKey);
      }
    });
  };
}
