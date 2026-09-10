import type { AIAnswer, AIConfig, ChoiceOption, Question } from '../shared/types';
import { appError, AppErrorException } from '../shared/errors';
import { validateConfig } from './config';

export type FetchImplementation = typeof fetch;

const ANSWER_MAX_TOKENS = 4096;

export function buildPrompt(question: Question): string {
  if (question.type === 'choice') {
    const mode = question.selectionMode === 'multiple' ? '多选题' : '单选题或判断题';
    const options = question.options?.map((option) => `${option.key}. ${option.text}`).join('\n') || '无';

    return [
      '你是在线课程选择题答题器。',
      '请根据题干和选项选择正确答案，判断题也按选项作答。',
      `题型：${mode}`,
      '只返回选项字母，不要返回解释、推理、Markdown 或其他文字。',
      '单选题或判断题只返回一个字母，例如 A；多选题返回多个字母并用逗号分隔，例如 A,C。',
      `题目标题：${question.title ?? ''}`,
      `题干：\n${question.content}`,
      `选项：\n${options}`
    ].join('\n\n');
  }

  if (question.type === 'fill') {
    const blankCount = question.blankCount ?? 0;
    const blankOrder = Array.from(
      { length: blankCount },
      (_, index) => `BLANK_${index + 1}`
    );
    const answerExample = `[${Array.from(
      { length: blankCount },
      (_, index) => `"答案${index + 1}"`
    ).join(',')}]`;
    return [
      '你是在线课程程序填空题求解器。',
      '请根据题目说明和带有 BLANK_N 占位符的代码，按空位出现顺序给出每个输入框应填写的内容。',
      `严格按 ${blankOrder.join('、')} 的顺序返回 ${blankCount} 个答案。`,
      `只返回 JSON 字符串数组，例如：${answerExample}。不要返回 Markdown、解释、编号或其他文字。`,
      '每个数组元素对应一个填空输入框，可以是标识符、表达式或代码片段；不要改写整个程序。',
      `题目标题：${question.title ?? ''}`,
      `题目说明：\n${question.content}`,
      `代码骨架：\n${question.editorCode ?? ''}`
    ].join('\n\n');
  }

  const examples = question.examples?.map((example, index) => {
    return [
      `示例 ${index + 1} 输入：${example.input ?? ''}`,
      `示例 ${index + 1} 输出：${example.output ?? ''}`
    ].join('\n');
  }).join('\n') || '无';
  const editorCode = question.editorCode?.trim() || '无';

  return [
    '你是编程题求解器。',
    '这是在线课程编程题，请根据题目约定完成函数或单个可直接运行的脚本源文件。',
    '题目明确规定的函数签名、输入输出方式、返回值和禁用函数必须优先遵守。',
    '评测系统会使用多组真实测试用例：根据实际输入或函数参数计算结果，不要把示例答案写死。',
    '不要生成项目结构、多个文件、README、依赖安装说明、测试框架、伪代码或解题说明。',
    '如果代码区已有代码，请优先在其基础上补全或修正，保留函数名、参数和可用的输入输出结构。',
    '只返回代码正文，不要 Markdown 代码块，不要解释。',
    '题目要求读取标准输入时，Python 必须使用 input() 读取在线平台提供的输入；禁止使用 sys.stdin、命令行参数、文件或环境变量读取输入。',
    '输入函数不得带提示文本，例如不要写 input("请输入...")，提示语会被判题系统当作输出。',
    '函数题通过函数参数传值，按指定签名实现并返回结果；题目禁止键盘输入时不要添加 input()。',
    '题目要求调用验证时，按题目示例保留或补充函数调用；平台直接调用函数评测时只实现函数，不添加额外调用或 print()。',
    '返回代码前，使用示例和至少一个边界用例自检语法、边界及结果；标准输入输出题必须执行并产生题目要求的输出，函数题必须返回题目要求的结果。',
    `题目标题：${question.title ?? ''}`,
    `编程语言：${question.language ?? 'Python'}`,
    `题目内容：\n${question.content}`,
    `已有代码：\n${editorCode}`,
    `样例：\n${examples}`
  ].join('\n\n');
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return (match?.[1] ?? trimmed).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeChoiceText(value: string): string {
  return value.replace(/[\s。.!！?？:：、，,]/g, '').toLowerCase();
}

function getChoiceResponseText(content: string): string {
  const stripped = stripCodeFence(content);

  try {
    const parsed: unknown = JSON.parse(stripped);
    if (typeof parsed === 'string') return parsed;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string').join(',');
    }
    if (isRecord(parsed)) {
      const value = parsed.answer ?? parsed.answers ?? parsed.choice
        ?? parsed.choices ?? parsed.selections;
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string').join(',');
      }
    }
  } catch {
    // Plain-text answers are handled below.
  }

  return stripped;
}

export function parseChoiceAnswer(content: string, question: Question): string[] {
  const options: ChoiceOption[] = question.options ?? [];
  const validKeys = new Set(options.map((option) => option.key.toUpperCase()));
  const responseText = getChoiceResponseText(content);
  const selections: string[] = [];

  for (const token of responseText.match(/[A-Za-z]+/g) ?? []) {
    const key = token.toUpperCase();
    if (validKeys.has(key) && !selections.includes(key)) selections.push(key);
  }

  if (selections.length === 0) {
    const normalizedResponse = normalizeChoiceText(responseText);
    for (const option of options) {
      if (normalizeChoiceText(option.text) === normalizedResponse) {
        selections.push(option.key.toUpperCase());
        break;
      }
    }
  }

  if (selections.length === 0) {
    throw appError('AI_RESPONSE_INVALID', 'AI 返回未识别出有效选项');
  }
  if (question.selectionMode !== 'multiple' && selections.length !== 1) {
    throw appError('AI_RESPONSE_INVALID', 'AI 返回了多个选项，但当前题目只能选择一个选项');
  }

  return selections;
}

function cleanFillValue(value: string): string {
  return value
    .trim()
    .replace(/^(?:答案|第?\d+空?)\s*[:：.、-]\s*/i, '')
    .trim();
}

export function parseFillAnswer(content: string, question: Question): string[] {
  const expectedCount = question.blankCount ?? 0;
  const stripped = stripCodeFence(content);
  let values: string[] | undefined;

  try {
    const parsed: unknown = JSON.parse(stripped);
    if (Array.isArray(parsed)) {
      values = parsed.filter((value): value is string => typeof value === 'string')
        .map(cleanFillValue);
    } else if (typeof parsed === 'string') {
      values = [cleanFillValue(parsed)];
    } else if (isRecord(parsed)) {
      const candidate = parsed.answers ?? parsed.values ?? parsed.blanks ?? parsed.answer;
      if (Array.isArray(candidate)) {
        values = candidate.filter((value): value is string => typeof value === 'string')
          .map(cleanFillValue);
      } else if (typeof candidate === 'string') {
        values = [cleanFillValue(candidate)];
      }
    }
  } catch {
    // Plain-text fallback is handled below.
  }

  if (!values) {
    values = stripped.split(/\r?\n/)
      .map(cleanFillValue)
      .filter((value) => value.length > 0);
  }

  if (values.length !== expectedCount || values.some((value) => value.length === 0)) {
    throw appError('AI_RESPONSE_INVALID', `AI 返回的填空答案数量无效，应为 ${expectedCount} 个`);
  }
  return values;
}

interface CompletionMessage {
  content?: unknown;
  reasoning_content?: unknown;
}

interface ChatCompletionPayload {
  choices?: Array<{
    message?: CompletionMessage;
    delta?: CompletionMessage;
    finish_reason?: string | null;
  }>;
}

interface ChatCompletion {
  content: string;
  hasReasoning: boolean;
  finishReason?: string;
}

function parseJsonPayload(text: string): ChatCompletionPayload | undefined {
  try {
    const payload: unknown = JSON.parse(text.replace(/^\uFEFF/, '').trim());
    return isRecord(payload) ? payload as ChatCompletionPayload : undefined;
  } catch {
    return undefined;
  }
}

function getCompletion(payload: ChatCompletionPayload): ChatCompletion {
  const choice = payload.choices?.[0];
  const content = choice?.message?.content ?? choice?.delta?.content;
  const reasoning = choice?.message?.reasoning_content ?? choice?.delta?.reasoning_content;
  return {
    content: typeof content === 'string' ? content : '',
    hasReasoning: typeof reasoning === 'string' && reasoning.trim().length > 0,
    finishReason: choice?.finish_reason ?? undefined
  };
}

function parseSseCompletion(text: string): ChatCompletion | undefined {
  const result: ChatCompletion = { content: '', hasReasoning: false };
  let foundDataLine = false;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;

    foundDataLine = true;
    const data = trimmed.slice('data:'.length).trim();
    if (!data || data === '[DONE]') continue;

    const payload = parseJsonPayload(data);
    if (!payload) return undefined;

    const chunk = getCompletion(payload);
    result.content += chunk.content;
    result.hasReasoning ||= chunk.hasReasoning;
    if (chunk.finishReason) result.finishReason = chunk.finishReason;
  }

  return foundDataLine ? result : undefined;
}

function getFinalContent(responseText: string): string {
  const payload = parseJsonPayload(responseText);
  const completion = payload ? getCompletion(payload) : parseSseCompletion(responseText);
  if (!completion) {
    throw appError('AI_RESPONSE_INVALID', 'AI 接口响应不是有效 JSON 或 SSE，请检查 Base URL 和接口模式');
  }
  if (completion.finishReason === 'length') {
    throw appError('AI_RESPONSE_INVALID', 'AI 输出达到长度上限，未获得完整答案，请重试或切换非思考模型');
  }
  if (!completion.content.trim()) {
    if (completion.hasReasoning) {
      throw appError('AI_RESPONSE_INVALID', 'AI 只返回了思考内容，未返回最终答案，请重试或切换非思考模型');
    }
    throw appError('AI_RESPONSE_INVALID', 'AI 未返回有效答案，请重试或检查模型配置');
  }
  return completion.content;
}

interface ChatMessage {
  role: 'user';
  content: string;
}

async function requestChatCompletion(
  config: AIConfig,
  messages: ChatMessage[],
  fetchImpl: FetchImplementation,
  maxTokens?: number,
  signal?: AbortSignal
): Promise<string> {
  validateConfig(config);

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeout);
  const abortHandler = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abortHandler, { once: true });
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  // DeepSeek V4 defaults to thinking, which shares the final answer's output budget.
  const useDirectOutput = new URL(config.baseUrl).origin === 'https://api.deepseek.com'
    && /^deepseek-v4(?:[.-]|$)/.test(config.model);

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
        ...(useDirectOutput ? { thinking: { type: 'disabled' } } : {}),
        messages
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw appError('AI_REQUEST_FAILED', `AI 请求失败：HTTP ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    if (error instanceof AppErrorException) throw error;
    const errorDetails = typeof error === 'object' && error !== null
      ? error as { name?: unknown; message?: unknown }
      : undefined;
    if (errorDetails?.name === 'AbortError') {
      throw appError(
        'AI_REQUEST_FAILED',
        timedOut || signal === undefined
          ? `AI 请求超时（${config.timeout}ms）`
          : 'AI 请求已取消'
      );
    }
    const detail = typeof errorDetails?.message === 'string' && errorDetails.message
      ? `：${errorDetails.message}`
      : '';
    throw appError('AI_REQUEST_FAILED', `AI 请求失败${detail}`);
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    clearTimeout(timeoutId);
  }
}

export async function askAI(
  question: Question,
  config: AIConfig,
  fetchImpl: FetchImplementation = fetch,
  signal?: AbortSignal
): Promise<AIAnswer> {
  const responseText = await requestChatCompletion(
    config,
    [{ role: 'user', content: buildPrompt(question) }],
    fetchImpl,
    ANSWER_MAX_TOKENS,
    signal
  );
  const content = getFinalContent(responseText);

  if (question.type === 'choice') {
    return {
      type: 'choice',
      selections: parseChoiceAnswer(content, question)
    };
  }

  if (question.type === 'fill') {
    return {
      type: 'fill',
      values: parseFillAnswer(content, question)
    };
  }

  const code = stripCodeFence(content);
  if (!code) throw appError('AI_RESPONSE_INVALID', 'AI 返回了空代码块，请重试或检查模型配置');

  return { type: 'programming', code };
}

export async function testAIConnection(
  config: AIConfig,
  fetchImpl: FetchImplementation = fetch
): Promise<void> {
  const responseText = await requestChatCompletion(
    config,
    [{ role: 'user', content: '只回复 OK' }],
    fetchImpl,
    16
  );
  getFinalContent(responseText);
}
