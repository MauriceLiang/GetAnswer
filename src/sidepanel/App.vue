<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../background/config';
import { isExtensionMessage } from '../shared/messages';
import type { AIAnswer, AIConfig, PageContext, Question, TaskStatus } from '../shared/types';
import { MODEL_PRESETS } from './model-presets';

const emptyPageContext: PageContext = {
  adapter: 'none',
  supported: false,
  hasVideo: false,
  hasEditor: false
};

const pageContext = ref<PageContext>(emptyPageContext);
const config = ref<AIConfig>({ ...DEFAULT_CONFIG });
const status = ref<TaskStatus>('idle');
const statusText = ref('等待识别页面');
const errorMessage = ref('');
const answerText = ref('');
const showConfigModal = ref(false);
const connectionMessage = ref('');
const connectionMessageType = ref<'success' | 'error' | ''>('');
const isTestingConnection = ref(false);
const autoSolveQuestionKey = ref<string | null>(null);
const autoAdvanceVideoKey = ref<string | null>(null);
const autoAnswerRunning = ref(false);
const autoAnswerStopped = ref(false);
const isStartingAnswer = ref(false);
const stoppedQuestionKeys = new Set<string>();
let solveGeneration = 0;
let autoSolveInFlight = false;
let autoAdvanceVideoInFlight = false;

const question = computed(() => pageContext.value.question);
const isSolving = computed(() => status.value === 'requesting' || status.value === 'filling');
const canSolve = computed(() => pageContext.value.supported
  && (question.value?.type === 'programming'
    || question.value?.type === 'choice'
    || question.value?.type === 'fill')
  && !isSolving.value);
const selectedModelPreset = computed({
  get(): string {
    return MODEL_PRESETS.find((preset) => (
      preset.baseUrl === config.value.baseUrl && preset.model === config.value.model
    ))?.id ?? 'custom';
  },
  set(presetId: string): void {
    const preset = MODEL_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;

    config.value = {
      ...config.value,
      baseUrl: preset.baseUrl,
      model: preset.model
    };
  }
});

function setError(message: string): void {
  errorMessage.value = message;
  status.value = 'error';
  statusText.value = message;
}

function getQuestionKey(value: Question): string {
  return JSON.stringify({
    id: value.id ?? '',
    type: value.type,
    title: value.title ?? '',
    content: value.content,
    examples: value.examples ?? [],
    language: value.language ?? '',
    editorCode: value.editorCode ?? '',
    blankCount: value.blankCount ?? 0,
    selectionMode: value.selectionMode ?? '',
    options: value.options ?? []
  });
}

function isCurrentQuestionKey(questionKey: string): boolean {
  return pageContext.value.question !== undefined
    && getQuestionKey(pageContext.value.question) === questionKey;
}

function isMessageForCurrentQuestion(questionKey?: string): boolean {
  if (questionKey !== undefined && stoppedQuestionKeys.has(questionKey)) return false;
  return questionKey === undefined || isCurrentQuestionKey(questionKey);
}

function isCurrentSolveActive(questionKey: string, generation: number): boolean {
  return generation === solveGeneration
    && isCurrentQuestionKey(questionKey)
    && !stoppedQuestionKeys.has(questionKey);
}

function formatAnswer(answer: AIAnswer): string {
  if (answer.type === 'programming') return answer.code;
  if (answer.type === 'choice') return `选项：${answer.selections.join('、')}`;
  return `填空：${answer.values.join('；')}`;
}

function getAnswerText(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('answer' in value)) return '';
  const answer = value.answer;
  if (typeof answer !== 'object' || answer === null || !('type' in answer)) return '';
  if (answer.type === 'programming' && 'code' in answer && typeof answer.code === 'string') {
    return answer.code;
  }
  if (answer.type === 'choice' && 'selections' in answer && Array.isArray(answer.selections)) {
    const selections = answer.selections.filter((selection): selection is string => (
      typeof selection === 'string'
    ));
    return selections.length > 0 ? `选项：${selections.join('、')}` : '';
  }
  if (answer.type === 'fill' && 'values' in answer && Array.isArray(answer.values)) {
    const values = answer.values.filter((value): value is string => typeof value === 'string');
    return values.length > 0 ? `填空：${values.join('；')}` : '';
  }
  return '';
}

function applyPageContext(context: PageContext): void {
  const previousQuestionKey = pageContext.value.question
    ? getQuestionKey(pageContext.value.question)
    : null;
  const nextQuestionKey = context.question ? getQuestionKey(context.question) : null;
  const questionChanged = previousQuestionKey !== nextQuestionKey;

  pageContext.value = context;
  errorMessage.value = '';
  if (questionChanged) answerText.value = '';
  if (context.supported && context.question) {
    autoAdvanceVideoKey.value = null;
    const stoppedCurrentQuestion = stoppedQuestionKeys.has(nextQuestionKey ?? '');
    if ((questionChanged || !isSolving.value) && !stoppedCurrentQuestion) {
      status.value = 'idle';
      statusText.value = '已识别';
    }
    maybeAutoSolve(context);
  } else if (context.supported && context.hasVideo) {
    autoSolveQuestionKey.value = null;
    const videoKey = context.videoSrc ?? 'video';
    const isSameVideo = autoAdvanceVideoKey.value === videoKey;
    if (!isSolving.value && !autoAdvanceVideoInFlight && !isSameVideo) {
      status.value = 'idle';
      statusText.value = '已识别视频';
    }
    maybeAutoAdvanceVideo(context);
  } else {
    autoSolveQuestionKey.value = null;
    autoAdvanceVideoKey.value = null;
    status.value = 'error';
    statusText.value = '当前页面暂不支持';
  }
}

const handleMessage = (message: unknown): void => {
  if (!isExtensionMessage(message)) return;

  if (message.type === 'PAGE_CONTEXT') {
    applyPageContext(message.data);
  } else if (message.type === 'AI_RESULT') {
    if (!isMessageForCurrentQuestion(message.questionKey)) return;
    answerText.value = formatAnswer(message.answer);
  } else if (message.type === 'STATUS') {
    if (!isMessageForCurrentQuestion(message.questionKey)) return;
    status.value = message.status;
    if (message.error) {
      setError(message.error.message);
    } else if (message.status === 'requesting') {
      statusText.value = '正在调用 AI';
      errorMessage.value = '';
    } else if (message.status === 'filling') {
      statusText.value = '正在填写答案';
      errorMessage.value = '';
    } else if (message.status === 'complete') {
      statusText.value = '完成';
      errorMessage.value = '';
    }
  } else if (message.type === 'FILL_RESULT') {
    if (message.success) {
      status.value = 'complete';
      statusText.value = '完成';
    } else if (message.error) {
      setError(message.error.message);
    }
  }
};

async function refresh(): Promise<void> {
  autoAdvanceVideoKey.value = null;
  status.value = 'scanning';
  statusText.value = '正在识别页面';
  errorMessage.value = '';

  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTEXT' });
    if (isExtensionMessage(response) && response.type === 'PAGE_CONTEXT') {
      applyPageContext(response.data);
    } else {
      setError('未收到有效的页面识别结果');
    }
  } catch {
    setError('无法连接到当前页面');
  }
}

async function startAutoAnswer(): Promise<void> {
  const generation = ++solveGeneration;
  isStartingAnswer.value = true;
  autoAnswerRunning.value = true;
  autoAnswerStopped.value = false;
  stoppedQuestionKeys.clear();
  autoSolveQuestionKey.value = null;
  answerText.value = '';
  status.value = 'scanning';
  statusText.value = '正在刷新页面';
  errorMessage.value = '';

  try {
    try {
      await chrome.runtime.sendMessage({ type: 'STOP_SOLVING' });
    } catch {
      // A previous request may already have ended; the page refresh can continue.
    }
    if (generation !== solveGeneration) return;

    const response: unknown = await chrome.runtime.sendMessage({ type: 'REFRESH_PAGE' });
    if (generation !== solveGeneration) return;
    if (!isExtensionMessage(response) || response.type !== 'REFRESH_PAGE_RESULT') {
      setError('未收到有效的页面刷新结果');
      return;
    }
    if (!response.success) {
      setError(response.error?.message ?? '刷新当前页面失败');
      return;
    }
    statusText.value = '页面刷新中，等待识别';
  } catch {
    if (generation === solveGeneration) setError('无法刷新当前页面');
  } finally {
    if (generation === solveGeneration) isStartingAnswer.value = false;
  }
}

async function stopAutoAnswer(): Promise<void> {
  const currentQuestionKey = question.value ? getQuestionKey(question.value) : null;
  if (currentQuestionKey) stoppedQuestionKeys.add(currentQuestionKey);
  solveGeneration += 1;
  autoAnswerRunning.value = false;
  autoAnswerStopped.value = true;
  isStartingAnswer.value = false;
  autoSolveQuestionKey.value = null;
  status.value = 'idle';
  statusText.value = '已停止自动答题';
  errorMessage.value = '';

  try {
    await chrome.runtime.sendMessage({ type: 'STOP_SOLVING' });
  } catch {
    // The local stop state still prevents late results from being applied.
  }
}

async function loadStoredConfig(): Promise<void> {
  config.value = await loadConfig(chrome.storage.local);
}

async function saveStoredConfig(): Promise<void> {
  try {
    await saveConfig(chrome.storage.local, config.value);
    statusText.value = '配置已保存';
    errorMessage.value = '';
    if (config.value.autoSolve && !autoAnswerStopped.value) {
      maybeAutoSolve(pageContext.value);
    } else {
      autoSolveQuestionKey.value = null;
    }
    if (config.value.autoAdvanceVideo) {
      maybeAutoAdvanceVideo(pageContext.value);
    } else {
      autoAdvanceVideoKey.value = null;
    }
  } catch (error) {
    setError(error instanceof Error ? error.message : '配置保存失败');
  }
}

async function testConnection(): Promise<void> {
  connectionMessage.value = '';
  connectionMessageType.value = '';
  isTestingConnection.value = true;
  status.value = 'requesting';
  statusText.value = '正在测试模型连接';
  errorMessage.value = '';

  try {
    await saveConfig(chrome.storage.local, config.value);
    const response: unknown = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
    if (!isExtensionMessage(response) || response.type !== 'TEST_CONNECTION_RESULT') {
      throw new Error('未收到有效的连通性测试结果');
    }
    if (!response.success) {
      const message = response.error?.message ?? '模型连接失败';
      connectionMessageType.value = 'error';
      connectionMessage.value = message;
      status.value = 'error';
      statusText.value = message;
      errorMessage.value = message;
      return;
    }

    connectionMessageType.value = 'success';
    connectionMessage.value = '连接成功';
    status.value = 'complete';
    statusText.value = '模型连接成功';
  } catch (error) {
    const message = error instanceof Error ? error.message : '模型连接测试失败';
    connectionMessageType.value = 'error';
    connectionMessage.value = message;
    status.value = 'error';
    statusText.value = message;
    errorMessage.value = message;
  } finally {
    isTestingConnection.value = false;
  }
}

function maybeAutoSolve(context: PageContext): void {
  if ((!config.value.autoSolve && !autoAnswerRunning.value) || !context.question
    || autoAnswerStopped.value
    || (context.question.type !== 'programming'
      && context.question.type !== 'choice'
      && context.question.type !== 'fill')) {
    return;
  }

  const key = getQuestionKey(context.question);
  if (autoSolveQuestionKey.value === key || autoSolveInFlight) return;

  autoSolveQuestionKey.value = key;
  autoSolveInFlight = true;
  void solve().finally(() => {
    autoSolveInFlight = false;
    if (pageContext.value.question) maybeAutoSolve(pageContext.value);
  });
}

function maybeAutoAdvanceVideo(context: PageContext): void {
  if (!config.value.autoAdvanceVideo || !context.supported || !context.hasVideo || context.question) {
    return;
  }

  const key = context.videoSrc ?? 'video';
  if (autoAdvanceVideoKey.value === key || autoAdvanceVideoInFlight) return;

  autoAdvanceVideoKey.value = key;
  autoAdvanceVideoInFlight = true;
  void advanceVideo().finally(() => {
    autoAdvanceVideoInFlight = false;
  });
}

async function solve(): Promise<void> {
  const currentQuestion = question.value;
  if (!canSolve.value || !currentQuestion) return;
  const currentQuestionKey = getQuestionKey(currentQuestion);
  const generation = solveGeneration;
  stoppedQuestionKeys.delete(currentQuestionKey);

  status.value = 'requesting';
  statusText.value = '正在调用 AI';
  errorMessage.value = '';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SOLVE_QUESTION',
      question: currentQuestion,
      questionKey: currentQuestionKey
    });
    if (!isCurrentSolveActive(currentQuestionKey, generation)) return;
    const answer = getAnswerText(response);
    if (answer) answerText.value = answer;
    if (response?.error?.message) setError(response.error.message);
  } catch (error) {
    if (!isCurrentSolveActive(currentQuestionKey, generation)) return;
    const detail = error instanceof Error && error.message ? `：${error.message}` : '';
    setError(`AI 解答请求失败${detail}`);
  }
}

async function advanceVideo(): Promise<void> {
  if (!pageContext.value.supported || !pageContext.value.hasVideo || question.value) return;

  status.value = 'filling';
  statusText.value = '正在完成视频';
  errorMessage.value = '';

  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: 'ADVANCE_VIDEO' });
    if (!isExtensionMessage(response) || response.type !== 'VIDEO_RESULT') {
      setError('未收到有效的视频处理结果');
      return;
    }
    if (!response.success) {
      setError(response.error?.message ?? '视频自动处理失败');
      return;
    }
    status.value = 'complete';
    statusText.value = '视频已完成，正在进入下一项';
  } catch {
    setError('视频页面处理失败');
  }
}

onMounted(() => {
  chrome.runtime.onMessage.addListener(handleMessage);
  void loadStoredConfig().then(refresh).catch(() => setError('配置读取失败'));
});

onBeforeUnmount(() => {
  chrome.runtime.onMessage.removeListener(handleMessage);
});
</script>

<template>
  <main class="panel">
    <header class="app-header">
      <div>
        <h1>AI 学习助手</h1>
        <p class="status" :class="`status-${status}`">状态：{{ statusText }}</p>
      </div>
      <button
        type="button"
        class="secondary settings-button"
        aria-label="打开模型配置"
        @click="showConfigModal = true"
      >模型配置</button>
    </header>

    <section class="question-card">
      <p>适配器：{{ pageContext.adapter }}</p>
      <p>题型：{{ question?.type === 'choice'
        ? '选择题'
        : question?.type === 'fill'
          ? '填空题'
          : question?.type ?? '未知' }}</p>
      <h2>{{ question?.title ?? '尚未识别题目' }}</h2>
      <p class="question-content">{{ question?.content ?? '请打开受支持的 AlphaCoding 编程题页面。' }}</p>
      <ul v-if="question?.type === 'choice'" class="choice-options">
        <li v-for="option in question.options" :key="option.key">
          {{ option.key }}. {{ option.text }}
        </li>
      </ul>
    </section>

    <div
      v-if="showConfigModal"
      class="modal-backdrop"
      @click.self="showConfigModal = false"
    >
      <section
        class="config-card config-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="config-title"
      >
        <div class="config-heading">
          <h2 id="config-title">模型配置</h2>
          <button
            type="button"
            class="modal-close"
            aria-label="关闭模型配置"
            @click="showConfigModal = false"
          >×</button>
        </div>
        <label>常用模型
          <select v-model="selectedModelPreset" name="model-preset">
            <option value="custom">自定义</option>
            <option v-for="preset in MODEL_PRESETS" :key="preset.id" :value="preset.id">
              {{ preset.label }}
            </option>
          </select>
        </label>
        <label>Base URL <input v-model="config.baseUrl" name="base-url" type="url" autocomplete="off" /></label>
        <label>API Key <input v-model="config.apiKey" type="password" autocomplete="off" /></label>
        <label>Model <input v-model="config.model" name="model" type="text" autocomplete="off" /></label>
        <label>Temperature <input v-model.number="config.temperature" type="number" min="0" step="0.1" /></label>
        <label>Timeout <input v-model.number="config.timeout" type="number" min="1" step="1000" /></label>
        <label class="checkbox-label">
          <input v-model="config.autoSolve" name="auto-solve" type="checkbox" />
          识别题目后自动解答
        </label>
        <p class="setting-hint">开启后，识别到编程题或选择题会自动调用 AI 并填写答案。</p>
        <label class="checkbox-label">
          <input v-model="config.autoAdvanceVideo" name="auto-advance-video" type="checkbox" />
          视频完成后自动进入下一项
        </label>
        <p class="setting-hint">开启后，会将视频进度移到最后并点击右下角的“下一项”。</p>
        <label class="checkbox-label">
          <input v-model="config.autoSubmit" name="auto-submit" type="checkbox" />
          生成答案后自动提交
        </label>
        <p class="setting-hint">开启后，答案填写成功会自动点击页面提交按钮。</p>
        <div class="config-actions">
          <button
            type="button"
            class="connection-test"
            :disabled="isTestingConnection"
            @click="testConnection"
          >{{ isTestingConnection ? '测试中…' : '测试连通性' }}</button>
          <button type="button" class="secondary" @click="saveStoredConfig">保存配置</button>
        </div>
        <p
          v-if="connectionMessage"
          class="connection-message"
          :class="`connection-message-${connectionMessageType}`"
          role="status"
        >{{ connectionMessage }}</p>
      </section>
    </div>

    <section class="actions">
      <button
        type="button"
        class="start-answer"
        :disabled="isStartingAnswer"
        @click="startAutoAnswer"
      >{{ isStartingAnswer ? '刷新中…' : '开始答题' }}</button>
      <button type="button" class="stop-answer" @click="stopAutoAnswer">停止答题</button>
      <button type="button" class="secondary" @click="refresh">重新识别</button>
      <button type="button" class="solve" :disabled="!canSolve" @click="solve">AI 解答并填写</button>
    </section>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <section v-if="answerText" class="answer-card">
      <h2>AI 答案</h2>
      <pre><code>{{ answerText }}</code></pre>
    </section>
  </main>
</template>

<style scoped>
.panel { padding: 16px; color: #1f2937; font: 14px/1.5 system-ui, sans-serif; }
.app-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h1 { margin: 0; font-size: 20px; }
h2 { margin: 8px 0; font-size: 15px; }
.status { margin: 4px 0 16px; color: #2563eb; }
.status-error, .error { color: #b91c1c; }
section { margin-bottom: 16px; }
.question-card, .config-card, .answer-card { padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; }
.question-content { white-space: pre-wrap; max-height: 240px; overflow: auto; }
.choice-options { margin: 8px 0 0; padding-left: 20px; }
label { display: block; margin: 8px 0; }
input, select { box-sizing: border-box; display: block; width: 100%; margin-top: 4px; padding: 6px 8px; }
.checkbox-label { display: flex; align-items: center; gap: 8px; }
.checkbox-label input { display: inline-block; width: auto; margin: 0; }
.setting-hint { margin: -4px 0 8px; color: #6b7280; font-size: 12px; }
.config-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.connection-test { color: #1d4ed8; background: #dbeafe; }
.connection-message { margin: 8px 0 0; }
.connection-message-success { color: #15803d; }
.connection-message-error { color: #b91c1c; }
button { border: 0; border-radius: 6px; padding: 8px 12px; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .5; }
.settings-button { flex: 0 0 auto; }
.modal-backdrop { position: fixed; inset: 0; z-index: 10; display: flex; justify-content: center; padding: 16px; overflow: auto; background: rgb(15 23 42 / 35%); }
.config-modal { width: min(100%, 360px); margin: 0; background: #fff; box-shadow: 0 12px 32px rgb(15 23 42 / 25%); }
.config-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.config-heading h2 { margin: 0; }
.modal-close { padding: 0 4px; color: #4b5563; background: transparent; font-size: 24px; line-height: 1; }
.actions { display: flex; gap: 8px; }
.start-answer { color: white; background: #16a34a; }
.stop-answer { color: white; background: #dc2626; }
.solve { color: white; background: #2563eb; }
.secondary { color: #1f2937; background: #e5e7eb; }
.answer-card pre { max-height: 300px; overflow: auto; padding: 8px; background: #111827; color: #f9fafb; }
</style>
