import type {
  AIAnswer,
  ChoiceOption,
  ExampleCase,
  ProjectAnswer,
  ProjectFile,
  Question,
  QuestionType
} from '../shared/types';
import { appError } from '../shared/errors';
import {
  isPythonProjectPath,
  normalizeProjectPath,
  preservesOriginalCode
} from '../shared/project-files';
import type { CodeFiller, CodeReader, FillAnswerOptions, SiteAdapter } from './base';

const SUBMIT_RESULT_TIMEOUT_MS = 10_000;
const PAGE_ANSWER_TIMEOUT_MS = 3_000;
const VIDEO_COMPLETION_OFFSET_SECONDS = 3;
const VIDEO_METADATA_TIMEOUT_MS = 10_000;
const VIDEO_SEEK_TIMEOUT_MS = 10_000;
const VIDEO_PLAYBACK_TIMEOUT_PADDING_MS = 10_000;
const NEXT_NAVIGATION_FALLBACK_MS = 300;
const PROJECT_FILE_SWITCH_TIMEOUT_MS = 3_000;
const nextItemClicked = new WeakMap<Document, symbol>();
const informationalPageSkipped = new WeakMap<Document, string>();
let submissionInFlight = false;

const defaultFillCode: CodeFiller = async () => {
  throw {
    code: 'EDITOR_WRITE_FAILED',
    message: '未配置 CodeMirror 页面桥'
  };
};

function textOf(element: Element | null): string {
  return element?.textContent?.replace(/\u00a0/g, ' ').trim() ?? '';
}

function getVideoDuration(video: HTMLVideoElement): number | null {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
}

function waitForVideoDuration(video: HTMLVideoElement): Promise<number> {
  const currentDuration = getVideoDuration(video);
  if (currentDuration !== null) return Promise.resolve(currentDuration);

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = (): void => {
      video.removeEventListener('loadedmetadata', handleMetadata);
      video.removeEventListener('durationchange', handleMetadata);
      clearTimeout(timer);
    };

    const handleMetadata = (): void => {
      const duration = getVideoDuration(video);
      if (duration === null) return;
      cleanup();
      resolve(duration);
    };

    video.addEventListener('loadedmetadata', handleMetadata);
    video.addEventListener('durationchange', handleMetadata);
    timer = setTimeout(() => {
      cleanup();
      reject(appError('VIDEO_ACTION_FAILED', '视频时长加载失败，未自动进入下一项'));
    }, VIDEO_METADATA_TIMEOUT_MS);
  });
}

function seekVideoToEnd(video: HTMLVideoElement, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = (): void => {
      video.removeEventListener('seeked', handleSeeked);
      clearTimeout(timer);
    };

    const handleSeeked = (): void => {
      cleanup();
      resolve();
    };

    video.addEventListener('seeked', handleSeeked);
    timer = setTimeout(() => {
      cleanup();
      reject(appError('VIDEO_ACTION_FAILED', '视频进度跳转失败，未自动进入下一项'));
    }, VIDEO_SEEK_TIMEOUT_MS);

    try {
      video.currentTime = duration;
    } catch {
      cleanup();
      reject(appError('VIDEO_ACTION_FAILED', '无法将视频进度拖动到最后'));
    }
  });
}

function waitForVideoPlaybackEnd(video: HTMLVideoElement, duration: number): Promise<void> {
  if (video.ended) return Promise.resolve();

  const remainingSeconds = Math.max(0, duration - video.currentTime);
  const playbackRate = Number.isFinite(video.playbackRate) && video.playbackRate > 0
    ? video.playbackRate
    : 1;
  const timeoutMs = Math.max(
    VIDEO_SEEK_TIMEOUT_MS,
    Math.ceil((remainingSeconds / playbackRate) * 1000) + VIDEO_PLAYBACK_TIMEOUT_PADDING_MS
  );

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    let restoreMuted: (() => void) | undefined;

    const restoreAudioState = (): void => {
      restoreMuted?.();
      restoreMuted = undefined;
    };

    const cleanup = (): void => {
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleError);
      clearTimeout(timer);
      restoreAudioState();
    };
    const handleEnded = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const handleError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(appError('VIDEO_ACTION_FAILED', '视频播放失败，未自动进入下一项'));
    };

    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleError);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(appError('VIDEO_ACTION_FAILED', '视频未播放完成，未自动进入下一项'));
    }, timeoutMs);

    const startPlayback = async (): Promise<void> => {
      try {
        await video.play();
        return;
      } catch {
        if (settled) return;
      }

      const wasMuted = video.muted;
      video.muted = true;
      try {
        await video.play();
      } catch {
        video.muted = wasMuted;
        throw new Error('muted playback was rejected');
      }
      if (settled) {
        video.muted = wasMuted;
        return;
      }
      restoreMuted = () => { video.muted = wasMuted; };
    };

    void startPlayback().catch(() => handleError());
  });
}

function findNextVideoControl(document: Document): HTMLElement | null {
  const nextLink = Array.from(
    document.querySelectorAll<HTMLElement>('.lesson-footer-nav a, .lesson-footer-nav button')
  ).find((link) => textOf(link).includes('下一项')
    && !link.matches(':disabled, [aria-disabled="true"]')
    && isVisible(link, document.defaultView));
  return nextLink ?? null;
}

function findHeaderNextControl(document: Document): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(
    '.course-navigations-buttons button'
  )).find((button) => button.querySelector('.fa-chevron-right') !== null
    && !button.matches(':disabled, [aria-disabled="true"]')
    && isVisible(button, document.defaultView)) ?? null;
}

function isVisible(element: Element, view: Window | null): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.getAttribute('aria-hidden') === 'true') return false;
    const style = view?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    current = current.parentElement;
  }
  return true;
}

function findSuccessfulSubmissionDialogs(document: Document): HTMLElement[] {
  const view = document.defaultView;
  return Array.from(
    document.querySelectorAll<HTMLElement>('.el-dialog__body, [role="dialog"], .el-overlay-dialog')
  ).filter((wrapper) => {
    const hasSuccessMarker = wrapper.querySelector(
      '.submit-result-wrap, .success-header, .fa-check-circle, .fa-check, [class*="success"]'
    ) !== null || /(?:回答正确|全部通过|恭喜)/.test(textOf(wrapper));
    return hasSuccessMarker && isVisible(wrapper, view);
  });
}

function findNextItemButton(resultWrappers: HTMLElement[]): HTMLButtonElement | null {
  for (const wrapper of resultWrappers) {
    const nextButton = Array.from(
      wrapper.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => textOf(button).includes('下一项')
      && !button.matches(':disabled, [aria-disabled="true"]'));
    if (nextButton && isVisible(nextButton, wrapper.ownerDocument.defaultView)) return nextButton;
  }

  return null;
}

function hasInlineSubmissionResult(document: Document): boolean {
  const view = document.defaultView;
  return Array.from(document.querySelectorAll('.check-result-status'))
    .some((result) => {
      const successMessage = result.querySelector('.text-green-500');
      return successMessage !== null
        && textOf(successMessage).length > 0
        && isVisible(successMessage, view);
    });
}

function hasProjectSubmissionResult(document: Document): boolean {
  if (findSubmitButton(document)?.disabled) return false;
  return Array.from(document.querySelectorAll('.project-exercise .project-judgment-result'))
    .some((result) => {
      const tasks = Array.from(result.querySelectorAll('.tasks-list .task'));
      // Task descriptions and status icons exist before grading; only the task classes change.
      return isVisible(result, document.defaultView)
        && tasks.length > 0
        && tasks.every((task) => task.classList.contains('task-status-ok'));
    });
}

function hasSubmissionFailure(document: Document): boolean {
  const view = document.defaultView;
  const failurePattern = /作答错误|回答错误|答案错误|不正确|未通过/;
  return Array.from(document.querySelectorAll(
    '.project-exercise .project-judgment-result .task-status-failed, '
    + '.project-exercise .project-judgment-result .task-status-error'
  )).some((task) => isVisible(task, view)) || Array.from(document.querySelectorAll(
    '.check-result-status, .el-dialog__body, [role="dialog"], .el-overlay-dialog'
  )).some((result) => isVisible(result, view) && failurePattern.test(textOf(result)));
}

const submissionResultSelector =
  '.check-result-status, .el-dialog__body, [role="dialog"], .el-overlay-dialog, '
  + '.project-exercise .project-judgment-result';

function isSubmissionResultNode(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return element !== null && (element.matches(submissionResultSelector)
    || element.closest(submissionResultSelector) !== null);
}

type SubmissionOutcome =
  | { type: 'success'; nextControl: HTMLElement }
  | { type: 'failure' };

function waitForSubmissionOutcome(document: Document): Promise<SubmissionOutcome> {
  const MutationObserverConstructor = document.defaultView?.MutationObserver;
  const root = document.body ?? document.documentElement;
  if (!MutationObserverConstructor || !root) {
    return Promise.reject(appError('SUBMIT_FAILED', '提交后未检测到答题结果'));
  }
  return new Promise((resolve, reject) => {
    let observer: MutationObserver;
    let timer: ReturnType<typeof setTimeout>;
    let resultMutated = false;

    const cleanup = (): void => {
      observer.disconnect();
      clearTimeout(timer);
    };

    const inspect = (): void => {
      if (!resultMutated) return;
      const nextControl = findSubmissionNextControl(document);
      if (nextControl) {
        cleanup();
        resolve({ type: 'success', nextControl });
        return;
      }
      if (hasSubmissionFailure(document)) {
        cleanup();
        resolve({ type: 'failure' });
      }
    };

    observer = new MutationObserverConstructor((records) => {
      if (records.some((record) => (
        isSubmissionResultNode(record.target)
        || Array.from(record.addedNodes).some(isSubmissionResultNode)
        || Array.from(record.removedNodes).some(isSubmissionResultNode)
      ))) {
        resultMutated = true;
      }
      inspect();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });
    timer = setTimeout(() => {
      cleanup();
      reject(appError('SUBMIT_FAILED', '提交后未检测到答题结果'));
    }, SUBMIT_RESULT_TIMEOUT_MS);
  });
}

function findSubmissionNextControl(document: Document): HTMLElement | null {
  if (hasSubmissionFailure(document)) return null;
  const successDialogs = findSuccessfulSubmissionDialogs(document);
  const dialogButton = findNextItemButton(successDialogs);
  if (dialogButton) return dialogButton;
  return successDialogs.length > 0 || hasInlineSubmissionResult(document) || hasProjectSubmissionResult(document)
    ? findNextVideoControl(document) ?? findHeaderNextControl(document)
    : null;
}

function extractEditorCode(document: Document): string | undefined {
  const editor = document.querySelector('.CodeMirror');
  if (!editor) return undefined;

  const lines = Array.from(editor.querySelectorAll('.CodeMirror-line'))
    .map((line) => line.textContent?.replace(/\u00a0/g, ' ') ?? '')
    .join('\n')
    .trim();
  if (lines) return lines;

  const textarea = editor.querySelector('textarea') as HTMLTextAreaElement | null;
  const textareaValue = textarea?.value.trim() ?? '';
  return textareaValue || undefined;
}

interface ProjectFileEntry {
  path: string;
  key?: string;
  trigger: HTMLElement;
}

interface ProjectFileSnapshot {
  entries: ProjectFileEntry[];
  files: ProjectFile[];
  activePath?: string;
}

function directTreeContent(node: HTMLElement): HTMLElement | null {
  return Array.from(node.children)
    .find((child) => child.classList.contains('el-tree-node__content')) as HTMLElement | null;
}

function projectFilePath(node: HTMLElement, fileName: string): string {
  const directories: string[] = [];
  let parent = node.parentElement?.closest<HTMLElement>('[role="treeitem"]');
  while (parent) {
    const content = directTreeContent(parent);
    const name = textOf(content?.querySelector('.filename') ?? null);
    const hasFileIcon = content?.querySelector('.file-icon i')?.className.includes('fa-file') ?? false;
    if (name && !hasFileIcon && !/^根目录$|^root$/i.test(name)) directories.unshift(name);
    parent = parent.parentElement?.closest<HTMLElement>('[role="treeitem"]');
  }
  return [...directories, fileName].join('/');
}

function projectFileEntries(document: Document): ProjectFileEntry[] {
  return Array.from(document.querySelectorAll<HTMLElement>(
    '.project-exercise .tree-file-explorer [role="treeitem"]'
  )).flatMap((node) => {
    const content = directTreeContent(node);
    const fileName = textOf(content?.querySelector('.filename') ?? null);
    const iconClass = content?.querySelector('.file-icon i')?.className ?? '';
    const hasChildren = Array.from(node.children)
      .some((child) => child.classList.contains('el-tree-node__children'));
    if (!content || !fileName || hasChildren || iconClass.includes('fa-folder')) return [];
    return [{
      path: projectFilePath(node, fileName),
      ...(node.dataset.key ? { key: node.dataset.key } : {}),
      trigger: content
    }];
  });
}

function projectFileBaseName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function projectFileTabMatches(
  tab: HTMLElement,
  entry: ProjectFileEntry,
  entries: ProjectFileEntry[]
): boolean {
  if (entry.key && tab.classList.contains(`file-${entry.key}`)) return true;
  const name = textOf(tab.querySelector('.file-name'));
  if (name === entry.path) return true;
  if (name !== projectFileBaseName(entry.path)) return false;
  return entries.filter((candidate) => (
    projectFileBaseName(candidate.path) === projectFileBaseName(entry.path)
  )).length === 1;
}

function activeProjectTab(document: Document): HTMLElement | null {
  return document.querySelector<HTMLElement>('.editor-tabs .tab-item.active');
}

function isProjectFileActive(
  document: Document,
  entry: ProjectFileEntry
): boolean {
  const tab = activeProjectTab(document);
  if (!tab) return false;
  return projectFileTabMatches(tab, entry, projectFileEntries(document));
}

function findProjectFileTab(
  document: Document,
  entry: ProjectFileEntry
): HTMLElement | null {
  const entries = projectFileEntries(document);
  return Array.from(document.querySelectorAll<HTMLElement>('.editor-tabs .tab-item'))
    .find((tab) => projectFileTabMatches(tab, entry, entries)) ?? null;
}

function activeProjectFilePath(
  document: Document,
  entries: ProjectFileEntry[]
): string | undefined {
  const tab = activeProjectTab(document);
  if (!tab) return undefined;
  const entry = entries.find((candidate) => projectFileTabMatches(tab, candidate, entries));
  return (entry?.path ?? textOf(tab.querySelector('.file-name'))) || undefined;
}

function waitForProjectFile(
  document: Document,
  entry: ProjectFileEntry
): Promise<void> {
  if (isProjectFileActive(document, entry)) return Promise.resolve();

  const MutationObserverConstructor = document.defaultView?.MutationObserver;
  const root = document.body ?? document.documentElement;
  if (!MutationObserverConstructor || !root) {
    return Promise.reject(appError('EDITOR_NOT_FOUND', '当前页面不支持切换项目文件'));
  }

  return new Promise((resolve, reject) => {
    let observer: MutationObserver;
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = (): void => {
      observer.disconnect();
      clearTimeout(timer);
    };
    const inspect = (): void => {
      if (!isProjectFileActive(document, entry)) return;
      cleanup();
      resolve();
    };

    observer = new MutationObserverConstructor(inspect);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });
    timer = setTimeout(() => {
      cleanup();
      reject(appError('EDITOR_NOT_FOUND', `切换项目文件失败：${entry.path}`));
    }, PROJECT_FILE_SWITCH_TIMEOUT_MS);
    inspect();
  });
}

async function selectProjectFile(
  document: Document,
  entry: ProjectFileEntry
): Promise<void> {
  if (!isProjectFileActive(document, entry)) {
    const tab = findProjectFileTab(document, entry);
    const pending = waitForProjectFile(document, entry);
    (tab ?? entry.trigger).click();
    await pending;
  }
  // The tab state and the CodeMirror value are updated by separate Vue ticks.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function collectVisibleProjectFiles(document: Document): ProjectFile[] {
  const entries = projectFileEntries(document);
  const activePath = activeProjectFilePath(document, entries);
  const activeCode = extractEditorCode(document) ?? '';
  return entries.map((entry) => ({
    path: entry.path,
    code: entry.path === activePath ? activeCode : '',
    editable: isPythonProjectPath(entry.path)
  }));
}

async function collectProjectFiles(
  document: Document,
  readCode?: CodeReader
): Promise<ProjectFileSnapshot> {
  const entries = projectFileEntries(document);
  if (entries.length === 0) {
    throw appError('EDITOR_NOT_FOUND', '未找到项目文件列表');
  }

  const activePath = activeProjectFilePath(document, entries);
  const files: ProjectFile[] = [];
  try {
    for (const entry of entries) {
      await selectProjectFile(document, entry);
      if (!document.querySelector('.CodeMirror')) {
        throw appError('EDITOR_NOT_FOUND', `未找到文件编辑器：${entry.path}`);
      }
      const code = readCode
        ? await readCode()
        : extractEditorCode(document) ?? '';
      files.push({
        path: entry.path,
        code,
        editable: isPythonProjectPath(entry.path)
      });
    }
  } finally {
    const originalEntry = entries.find((entry) => entry.path === activePath);
    if (originalEntry) await selectProjectFile(document, originalEntry);
  }

  return { entries, files, ...(activePath ? { activePath } : {}) };
}

function fillInputs(document: Document): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>(
    '.code-fill-exercise input.blank, .simple-fill-blank-exercise input.blank, .blank-input input.blank'
  ));
}

function extractFillCode(document: Document): { code: string; blankCount: number } {
  const inputs = fillInputs(document);
  const inputIndexes = new Map(inputs.map((input, index) => [input, index + 1]));
  const editor = document.querySelector<HTMLElement>(
    '.code-fill-exercise .CodeMirror, .simple-fill-blank-exercise .CodeMirror'
  );
  const lines = Array.from(editor?.querySelectorAll('.CodeMirror-line') ?? []).map((line) => {
    const clone = line.cloneNode(true) as HTMLElement;
    const originalInputs = Array.from(line.querySelectorAll<HTMLInputElement>('input.blank'));
    clone.querySelectorAll<HTMLInputElement>('input.blank').forEach((input, index) => {
      const blankIndex = inputIndexes.get(originalInputs[index]);
      const blankContainer = input.closest('.blank-input') ?? input;
      blankContainer.replaceWith(document.createTextNode(
        blankIndex === undefined ? '' : `{{BLANK_${blankIndex}}}`
      ));
    });
    return clone.textContent?.replace(/\u00a0/g, ' ') ?? '';
  });

  return { code: lines.join('\n').trim(), blankCount: inputs.length };
}

function extractQuestionContent(document: Document, type: QuestionType): string {
  const selectors = type === 'fill'
    ? [
      '.code-fill-exercise .exercise-description .markdown-body',
      '.exercise-description .markdown-body',
      '.exercise-content .markdown-body'
    ]
    : ['.exercise-content .markdown-body'];
  const content = selectors.map((selector) => textOf(document.querySelector(selector)))
    .find((value) => value.length > 0) ?? '';
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n');
}

function extractTaskRequirements(document: Document): string | undefined {
  const taskDescriptions = Array.from(
    document.querySelectorAll('.exercise-tasks .task-description .markdown-body')
  );
  const fallbackDescriptions = taskDescriptions.length > 0
    ? taskDescriptions
    : Array.from(document.querySelectorAll('.exercise-tasks .task-description'));
  const requirements = fallbackDescriptions
    .map((element) => textOf(element))
    .filter((value) => value.length > 0)
    .join('\n');
  return requirements
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n') || undefined;
}

function collectExamples(document: Document): ExampleCase[] | undefined {
  const inputs = Array.from(document.querySelectorAll('pre.sample-input'))
    .map((element) => textOf(element));
  const outputs = Array.from(document.querySelectorAll('pre.sample-output'))
    .map((element) => textOf(element));
  const count = Math.max(inputs.length, outputs.length);
  const examples: ExampleCase[] = [];

  for (let index = 0; index < count; index += 1) {
    const example: ExampleCase = {};
    if (inputs[index]) example.input = inputs[index];
    if (outputs[index]) example.output = outputs[index];
    if (Object.keys(example).length > 0) examples.push(example);
  }

  return examples.length > 0 ? examples : undefined;
}

function collectFillExamples(document: Document): ExampleCase[] | undefined {
  const description = document.querySelector(
    '.code-fill-exercise .exercise-description .markdown-body, '
      + '.simple-fill-blank-exercise .exercise-description .markdown-body'
  );
  if (!description) return undefined;

  const examples: ExampleCase[] = [];
  let pendingInput: string | undefined;
  for (const heading of Array.from(description.querySelectorAll('h3, h4'))) {
    const label = textOf(heading);
    const codeBlock = heading.nextElementSibling?.matches('pre')
      ? heading.nextElementSibling
      : null;
    if (!codeBlock) continue;

    const value = textOf(codeBlock);
    if (/输入|input/i.test(label)) {
      pendingInput = value;
      continue;
    }
    if (!/输出|output/i.test(label)) continue;

    const example: ExampleCase = {};
    if (pendingInput !== undefined) example.input = pendingInput;
    if (value) example.output = value;
    if (Object.keys(example).length > 0) examples.push(example);
    pendingInput = undefined;
  }

  return examples.length > 0 ? examples : undefined;
}

function extractLanguage(content: string): string | undefined {
  const match = content.match(/(?:编程语言|语言)\s*[:：]\s*([A-Za-z][A-Za-z0-9+#.-]*)/);
  return match?.[1];
}

function choiceInputs(document: Document): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>(
    '.choice-options-list input[type="radio"], .choice-options-list input[type="checkbox"]'
  ));
}

function selectSingleChoice(document: Document, index: number): void {
  const inputs = choiceInputs(document);
  const selectedInput = inputs[index];
  if (!selectedInput) throw appError('EDITOR_WRITE_FAILED', '未找到要选择的选项');

  for (const [inputIndex, input] of inputs.entries()) {
    const shouldBeChecked = inputIndex === index;
    if (input.checked !== shouldBeChecked) input.click();
  }
}

function choiceOptions(document: Document): ChoiceOption[] {
  return choiceInputs(document).map((input, index) => ({
    key: String.fromCharCode(65 + index),
    text: textOf(input.closest('label') ?? input.parentElement)
  }));
}

function choiceSelectionMode(
  typeName: string,
  inputs: HTMLInputElement[]
): 'single' | 'multiple' {
  return typeName.includes('多选') || inputs.some((input) => input.type === 'checkbox')
    ? 'multiple'
    : 'single';
}

function currentExercise(document: Document): HTMLElement | null {
  const view = document.defaultView;
  return Array.from(document.querySelectorAll<HTMLElement>('.exercise'))
    .find((exercise) => isVisible(exercise, view)) ?? null;
}

function findPageAnswerButton(exercise: HTMLElement): HTMLButtonElement | null {
  const view = exercise.ownerDocument.defaultView;
  return Array.from(exercise.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => textOf(button).includes('查看答案')
      && !button.matches(':disabled, [aria-disabled="true"]')
      && isVisible(button, view)) ?? null;
}

function findPageSolutionTab(exercise: HTMLElement): HTMLElement | null {
  const view = exercise.ownerDocument.defaultView;
  return Array.from(exercise.querySelectorAll<HTMLElement>(
    '[role="tab"], .el-tabs__item, button'
  )).find((tab) => textOf(tab) === '解析'
    && !tab.matches(':disabled, [aria-disabled="true"]')
    && isVisible(tab, view)) ?? null;
}

function isPageTabActive(tab: HTMLElement): boolean {
  return tab.classList.contains('is-active') || tab.getAttribute('aria-selected') === 'true';
}

function findPageAnswerSolution(exercise: HTMLElement): HTMLElement | null {
  const view = exercise.ownerDocument.defaultView;
  return Array.from(exercise.querySelectorAll<HTMLElement>(
    '.explain-and-solution .exercise-solution'
  )).find((solution) => textOf(solution.querySelector('h3')) === '答案'
    && isVisible(solution, view)) ?? null;
}

function pageAnswerValues(solution: HTMLElement): string[] {
  const caption = solution.querySelector('.explain-caption');
  const content = caption?.nextElementSibling ?? solution;
  const listItems = Array.from(content.querySelectorAll<HTMLElement>('ul > li, ol > li'))
    .map((element) => textOf(element))
    .filter(Boolean);
  if (listItems.length > 0) return listItems;

  const leaves = content.children.length === 0
    ? [content]
    : Array.from(content.querySelectorAll<HTMLElement>('*'))
      .filter((element) => element.children.length === 0
        && !element.matches('button, script, style'));
  const values = leaves.map((element) => textOf(element)).filter(Boolean);
  return values.length > 0 ? values : [textOf(content)].filter(Boolean);
}

function normalizeAnswerText(value: string): string {
  return value.replace(/\s+/g, '');
}

function unwrapInlineMarkdownCode(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^`([^`\r\n]+)`$/);
  return match?.[1].trim() ?? trimmed;
}

function parseChoiceValue(value: string, options: ChoiceOption[]): string | null {
  const unwrappedValue = unwrapInlineMarkdownCode(value);
  const normalizedValue = normalizeAnswerText(unwrappedValue);
  const exactOption = options.find((option) => (
    normalizeAnswerText(option.text) === normalizedValue
  ));
  if (exactOption) return exactOption.key.toUpperCase();

  const keyMatch = unwrappedValue.match(/^(?:选项\s*)?([A-Za-z])(?:[.．、:：\s]+(.*))?$/);
  if (!keyMatch) return null;
  const key = keyMatch[1].toUpperCase();
  const option = options.find((candidate) => candidate.key.toUpperCase() === key);
  if (!option) return null;

  const optionText = keyMatch[2]?.trim();
  return optionText === undefined || normalizeAnswerText(optionText) === normalizeAnswerText(option.text)
    ? key
    : null;
}

function splitPageAnswer(value: string): string[] {
  return value.split(/[\r\n,，;；、]+/).map((item) => item.trim()).filter(Boolean);
}

function parsePageChoiceAnswer(
  solution: HTMLElement,
  question: Question
): AIAnswer | null {
  if (question.type !== 'choice') return null;
  const options = question.options ?? [];
  const rawValues = pageAnswerValues(solution);
  if (options.length === 0 || rawValues.length === 0) return null;

  let selections = rawValues.map((value) => parseChoiceValue(value, options));
  if (selections.some((selection) => selection === null) && rawValues.length === 1) {
    selections = splitPageAnswer(rawValues[0]).map((value) => parseChoiceValue(value, options));
  }
  if (selections.some((selection) => selection === null)) return null;

  const uniqueSelections = [...new Set(selections as string[])];
  if (question.selectionMode === 'single' && uniqueSelections.length !== 1) return null;
  if (uniqueSelections.length === 0) return null;
  return { type: 'choice', selections: uniqueSelections };
}

function parsePageFillAnswer(
  solution: HTMLElement,
  question: Question
): AIAnswer | null {
  if (question.type !== 'fill') return null;
  const blankCount = question.blankCount;
  if (typeof blankCount !== 'number' || !Number.isInteger(blankCount) || blankCount <= 0) return null;

  const rawValues = pageAnswerValues(solution);
  if (rawValues.length === blankCount) {
    return { type: 'fill', values: rawValues };
  }
  if (rawValues.length !== 1 || blankCount <= 1) return null;

  const value = rawValues[0].replace(/^答案\s*[:：]\s*/, '');
  const splitValues = splitPageAnswer(value);
  return splitValues.length === blankCount
    ? { type: 'fill', values: splitValues }
    : null;
}

function parsePageProgrammingAnswer(solution: HTMLElement): AIAnswer | null {
  const code = solution.querySelector('pre.code-solution, pre')?.textContent?.trim() ?? '';
  return code ? { type: 'programming', code } : null;
}

function parsePageProjectAnswer(solution: HTMLElement): AIAnswer | null {
  const files = Array.from(solution.querySelectorAll<HTMLElement>('.space-y-1'))
    .flatMap((fileBlock) => {
      const path = textOf(fileBlock.querySelector('h3'));
      const code = fileBlock.querySelector('pre.code-solution, pre')?.textContent?.trim() ?? '';
      return path && code ? [{ path, code }] : [];
    });
  return files.length > 0 ? { type: 'project', files } : null;
}

function parsePageAnswer(
  solution: HTMLElement,
  question: Question
): AIAnswer | null {
  switch (question.type) {
    case 'choice':
      return parsePageChoiceAnswer(solution, question);
    case 'fill':
      return parsePageFillAnswer(solution, question);
    case 'programming':
      return parsePageProgrammingAnswer(solution);
    case 'project':
      return parsePageProjectAnswer(solution);
    default:
      return null;
  }
}

function findSubmitButton(document: Document): HTMLButtonElement | null {
  const programmingButton = document.querySelector<HTMLButtonElement>('.submit-btn button');
  if (programmingButton) return programmingButton;

  const projectButton = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.project-exercise .toolbar button')
  ).find((button) => textOf(button).includes('提交') && !textOf(button).includes('查看答案'));
  if (projectButton) return projectButton;

  const fillButton = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.code-fill-submit button')
  ).find((button) => textOf(button).includes('提交') && !textOf(button).includes('查看答案'));
  if (fillButton) return fillButton;

  return Array.from(document.querySelectorAll<HTMLButtonElement>('.controls button'))
    .find((button) => textOf(button).includes('提交') && !textOf(button).includes('查看答案')) ?? null;
}

function currentPath(location: Location): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function navigationKey(document: Document, location: Location): string {
  return JSON.stringify([
    currentPath(location),
    Array.from(document.querySelectorAll('[exerciseid]')).map((exercise) => [
      exercise.getAttribute('lessonid'), exercise.getAttribute('exerciseid')
    ])
  ]);
}

function nextNavigationTarget(control: HTMLElement, location: Location): string | null {
  const link = control.tagName.toLowerCase() === 'a'
    ? control as HTMLAnchorElement
    : control.closest<HTMLAnchorElement>('a');
  if (!link) return null;

  const target = link.getAttribute('to') ?? link.getAttribute('href');
  if (!target || target === 'javascript:void(0)') return null;

  return new URL(target, location.href).href;
}

function clickNextItemButton(
  control: HTMLElement,
  location: Location,
  navigate: (url: string) => void,
  allowSubmissionFallback = false
): void {
  const document = control.ownerDocument;
  if (nextItemClicked.has(document)) return;
  const attempt = Symbol();
  nextItemClicked.set(document, attempt);
  const keyBeforeClick = navigationKey(document, location);
  const isCurrent = (): boolean => nextItemClicked.get(document) === attempt
    && navigationKey(document, location) === keyBeforeClick
    && (!allowSubmissionFallback || !hasSubmissionFailure(document));

  const click = (nextControl: HTMLElement, onNoNavigation?: () => void): void => {
    if (!isCurrent()) return;
    const targetUrl = nextNavigationTarget(nextControl, location);
    nextControl.click();
    if (!targetUrl && !onNoNavigation) return;
    setTimeout(() => {
      if (!isCurrent()) return;
      if (targetUrl) {
        navigate(targetUrl);
        if (onNoNavigation) {
          setTimeout(() => { if (isCurrent()) onNoNavigation(); }, NEXT_NAVIGATION_FALLBACK_MS);
        }
      } else {
        onNoNavigation?.();
      }
    }, NEXT_NAVIGATION_FALLBACK_MS);
  };

  if (!allowSubmissionFallback || control === findHeaderNextControl(document)) {
    click(control);
    return;
  }
  const clickHeader = (): void => {
    const header = findHeaderNextControl(document);
    if (header) click(header);
  };
  click(control, () => {
    const footer = findNextVideoControl(document);
    if (footer && footer !== control) click(footer, clickHeader);
    else clickHeader();
  });
}

export class AlphaCodingAdapter implements SiteAdapter {
  name = 'alphacoding';
  private submissionObserver?: MutationObserver;
  private originalProjectSnapshot?: ProjectFileSnapshot;

  constructor(
    private readonly document: Document,
    private readonly location: Location,
    private readonly fillCode: CodeFiller = defaultFillCode,
    private readonly navigate: (url: string) => void = (url) => location.assign(url),
    private readonly readCode?: CodeReader
  ) {}

  match(): boolean {
    return this.location.hostname === 'nuc.alphacoding.cn';
  }

  detectQuestionType(): QuestionType {
    const typeName = textOf(this.document.querySelector('.exercise-type-name'));
    if ((typeName.includes('综合项目') || this.document.querySelector('.project-exercise'))
      && projectFileEntries(this.document).some((entry) => isPythonProjectPath(entry.path))) {
      return 'project';
    }
    if (typeName === '编程题') return 'programming';
    if (typeName.includes('填空') && fillInputs(this.document).length > 0) return 'fill';
    if (/(?:选择|单选|多选|判断)题?/.test(typeName) && choiceInputs(this.document).length > 0) {
      return 'choice';
    }
    return 'unknown';
  }

  isInformationalPage(): boolean {
    return this.detectQuestionType() === 'unknown'
      && this.document.querySelector('.fragment-container.page.document') !== null
      && findNextVideoControl(this.document) !== null;
  }

  skipInformationalPage(): void {
    if (!this.isInformationalPage()) {
      throw appError('PAGE_NOT_SUPPORTED', '当前页面不是可跳过的信息页');
    }

    const nextControl = findNextVideoControl(this.document);
    if (!nextControl) {
      throw appError('PAGE_NOT_SUPPORTED', '信息页没有找到下一项按钮');
    }
    const pageKey = navigationKey(this.document, this.location);
    if (informationalPageSkipped.get(this.document) === pageKey) return;
    informationalPageSkipped.set(this.document, pageKey);
    nextItemClicked.delete(this.document);
    clickNextItemButton(nextControl, this.location, this.navigate);
  }

  extractQuestion(): Question | null {
    const type = this.detectQuestionType();
    if (type !== 'programming' && type !== 'project' && type !== 'choice' && type !== 'fill') {
      return null;
    }

    const content = extractQuestionContent(this.document, type);
    if (!content) return null;

    const title = textOf(
      this.document.querySelector('.exercise-content .exercise-title, .exercise-content h2, .lesson-title h1')
    ) || undefined;
    const requirements = extractTaskRequirements(this.document);

    if (type === 'choice') {
      const inputs = choiceInputs(this.document);
      const options = choiceOptions(this.document);
      if (options.length === 0) return null;

      return {
        type,
        ...(title ? { title } : {}),
        content,
        ...(requirements ? { requirements } : {}),
        selectionMode: choiceSelectionMode(
          textOf(this.document.querySelector('.exercise-type-name')),
          inputs
        ),
        options
      };
    }

    if (type === 'fill') {
      const fillCode = extractFillCode(this.document);
      if (fillCode.blankCount === 0 || !fillCode.code) return null;
      const examples = collectFillExamples(this.document);

      return {
        type,
        ...(title ? { title } : {}),
        content,
        ...(requirements ? { requirements } : {}),
        ...(examples ? { examples } : {}),
        editorCode: fillCode.code,
        blankCount: fillCode.blankCount
      };
    }

    if (type === 'project') {
      const files = collectVisibleProjectFiles(this.document);
      if (!files.some((file) => file.editable)) return null;
      return {
        type,
        ...(title ? { title } : {}),
        content,
        ...(requirements ? { requirements } : {}),
        files
      };
    }

    const language = extractLanguage(content);
    const examples = collectExamples(this.document);
    const editorCode = extractEditorCode(this.document);

    return {
      type: 'programming',
      ...(title ? { title } : {}),
      content,
      ...(requirements ? { requirements } : {}),
      ...(language ? { language } : {}),
      ...(examples ? { examples } : {}),
      ...(editorCode ? { editorCode } : {})
    };
  }

  async extractAnswer(): Promise<AIAnswer | null> {
    const question = this.extractQuestion();
    if (!question || question.type === 'unknown') return null;

    const exercise = currentExercise(this.document);
    if (!exercise) return null;

    const parse = (solution: HTMLElement): AIAnswer | null => {
      return parsePageAnswer(solution, question);
    };
    const existingSolution = findPageAnswerSolution(exercise);
    if (existingSolution) {
      const answer = parse(existingSolution);
      if (answer) return answer;
    }

    const solutionTab = findPageSolutionTab(exercise);
    const shouldOpenSolutionTab = solutionTab !== null && !isPageTabActive(solutionTab);
    const button = shouldOpenSolutionTab ? null : findPageAnswerButton(exercise);
    const MutationObserverConstructor = this.document.defaultView?.MutationObserver;
    const root = this.document.body ?? this.document.documentElement;
    if ((!button && !existingSolution && !shouldOpenSolutionTab)
      || !MutationObserverConstructor || !root) return null;

    return new Promise((resolve) => {
      let observer: MutationObserver | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let answerButtonClicked = false;

      const cleanup = (): void => {
        observer?.disconnect();
        if (timer !== undefined) clearTimeout(timer);
      };
      const finish = (answer: AIAnswer | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(answer);
      };
      const inspect = (): void => {
        const solution = findPageAnswerSolution(exercise);
        if (solution) {
          const answer = parse(solution);
          if (answer) {
            finish(answer);
            return;
          }
        }
        if (existingSolution || answerButtonClicked) return;

        const button = findPageAnswerButton(exercise);
        if (!button) return;
        answerButtonClicked = true;
        try {
          button.click();
        } catch {
          finish(null);
        }
      };

      observer = new MutationObserverConstructor(inspect);
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      });
      timer = setTimeout(() => finish(null), PAGE_ANSWER_TIMEOUT_MS);
      if (shouldOpenSolutionTab && solutionTab) {
        try {
          solutionTab.click();
        } catch {
          finish(null);
          return;
        }
      }
      inspect();
    });
  }

  async extractQuestionAsync(): Promise<Question | null> {
    if (this.detectQuestionType() !== 'project') return this.extractQuestion();
    const question = this.extractQuestion();
    if (!question || question.type !== 'project') return null;
    const snapshot = await collectProjectFiles(this.document, this.readCode);
    return { ...question, files: snapshot.files };
  }

  async fillAnswer(answer: AIAnswer, options?: FillAnswerOptions): Promise<void> {
    if (answer.type === 'project') {
      await this.fillProjectAnswer(answer, options?.allowOverwrite === true);
      return;
    }

    if (answer.type === 'fill') {
      const inputs = fillInputs(this.document);
      if (inputs.length === 0) {
        throw appError('EDITOR_WRITE_FAILED', '未找到填空输入框');
      }
      if (answer.values.length !== inputs.length) {
        throw appError('EDITOR_WRITE_FAILED', 'AI 返回的填空数量与页面不一致');
      }

      const view = this.document.defaultView;
      const inputSetter = view?.HTMLInputElement
        ? Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set
        : undefined;
      for (const [index, input] of inputs.entries()) {
        if (inputSetter) inputSetter.call(input, answer.values[index]);
        else input.value = answer.values[index];
        input.dispatchEvent(new (view?.Event ?? Event)('input', { bubbles: true }));
        input.dispatchEvent(new (view?.Event ?? Event)('change', { bubbles: true }));
      }
      return;
    }

    if (answer.type === 'choice') {
      const inputs = choiceInputs(this.document);
      const selected = new Set(answer.selections.map((selection) => selection.toUpperCase()));
      if (inputs.length === 0) {
        throw appError('EDITOR_WRITE_FAILED', '未找到选择题选项');
      }
      if (inputs[0].type === 'radio' && selected.size !== 1) {
        throw appError('EDITOR_WRITE_FAILED', '单选题必须且只能选择一个选项');
      }

      for (const [index, input] of inputs.entries()) {
        const key = String.fromCharCode(65 + index);
        const shouldBeChecked = selected.has(key);
        if (input.checked !== shouldBeChecked) input.click();
      }
      return;
    }

    if (answer.type !== 'programming' || !answer.code.trim()) {
      throw {
        code: 'EDITOR_WRITE_FAILED',
        message: '编程题答案为空'
      };
    }
    await this.fillCode(answer.code);
  }

  private async fillProjectAnswer(answer: ProjectAnswer, allowOverwrite = false): Promise<void> {
    const snapshot = await collectProjectFiles(this.document, this.readCode);
    if (allowOverwrite) this.originalProjectSnapshot = snapshot;
    const sourceByPath = new Map(
      snapshot.files.map((file) => [normalizeProjectPath(file.path), file])
    );
    const editableFiles = snapshot.files.filter((file) => (
      file.editable && isPythonProjectPath(file.path)
    ));
    const candidates = new Map<string, string>();

    for (const file of answer.files) {
      const normalizedPath = normalizeProjectPath(file.path);
      const sourceFile = sourceByPath.get(normalizedPath);
      if (!sourceFile?.editable || !isPythonProjectPath(sourceFile.path)) {
        throw appError('EDITOR_WRITE_FAILED', `只允许修改 Python 文件：${file.path}`);
      }
      if (candidates.has(normalizedPath)) {
        throw appError('EDITOR_WRITE_FAILED', `重复的项目文件：${sourceFile.path}`);
      }
      if (!allowOverwrite && !preservesOriginalCode(sourceFile.code, file.code)) {
        throw appError('EDITOR_WRITE_FAILED', `AI 修改了 ${sourceFile.path} 的原有代码`);
      }
      candidates.set(normalizedPath, file.code);
    }

    if (candidates.size !== editableFiles.length) {
      const missingFile = editableFiles.find((file) => (
        !candidates.has(normalizeProjectPath(file.path))
      ));
      throw appError(
        'EDITOR_WRITE_FAILED',
        `AI 未返回 Python 文件：${missingFile?.path ?? '数量不匹配'}`
      );
    }

    const writeTargets = editableFiles.map((file) => {
      const entry = snapshot.entries.find((candidate) => (
        normalizeProjectPath(candidate.path) === normalizeProjectPath(file.path)
      ));
      const code = candidates.get(normalizeProjectPath(file.path));
      if (!entry || code === undefined) {
        throw appError('EDITOR_NOT_FOUND', `未找到项目文件：${file.path}`);
      }
      return { entry, file, code };
    });
    const writtenTargets: typeof writeTargets = [];

    try {
      for (const target of writeTargets) {
        await selectProjectFile(this.document, target.entry);
        // Mark before calling the bridge: a lost response may occur after setValue().
        writtenTargets.push(target);
        await this.fillCode(target.code);
      }
    } catch (error) {
      let rollbackFailed = false;
      for (const target of writtenTargets.reverse()) {
        try {
          await selectProjectFile(this.document, target.entry);
          await this.fillCode(target.file.code);
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) {
        throw appError(
          'EDITOR_WRITE_FAILED',
          '项目文件写入失败，自动回滚也失败，请手动检查并恢复代码'
        );
      }
      throw error;
    } finally {
      const originalEntry = snapshot.entries.find((entry) => entry.path === snapshot.activePath);
      if (originalEntry) await selectProjectFile(this.document, originalEntry);
    }
  }

  async restoreOriginalProjectFiles(): Promise<void> {
    const snapshot = this.originalProjectSnapshot;
    this.originalProjectSnapshot = undefined;
    if (!snapshot) return;

    const writeTargets = snapshot.files
      .filter((file) => file.editable && isPythonProjectPath(file.path))
      .map((file) => {
        const entry = snapshot.entries.find((candidate) => (
          normalizeProjectPath(candidate.path) === normalizeProjectPath(file.path)
        ));
        if (!entry) throw appError('EDITOR_NOT_FOUND', `未找到项目文件：${file.path}`);
        return { entry, file };
      });

    try {
      for (const target of writeTargets) {
        await selectProjectFile(this.document, target.entry);
        await this.fillCode(target.file.code);
      }
    } finally {
      const originalEntry = snapshot.entries.find((entry) => entry.path === snapshot.activePath);
      if (originalEntry) await selectProjectFile(this.document, originalEntry);
    }
  }

  async submitAnswer(): Promise<void> {
    submissionInFlight = true;
    try {
      nextItemClicked.delete(this.document);

      const inputs = choiceInputs(this.document);
      const selectedIndex = inputs.findIndex((input) => input.checked);
      if (inputs.length > 0 && inputs[0].type === 'radio' && selectedIndex >= 0) {
        const attemptIndexes = [
          selectedIndex,
          ...inputs.map((_, index) => index).filter((index) => index !== selectedIndex)
        ];

        for (const [attempt, index] of attemptIndexes.entries()) {
          if (attempt > 0) selectSingleChoice(this.document, index);

          const button = findSubmitButton(this.document);
          if (!button) throw appError('SUBMIT_FAILED', '未找到提交按钮');

          const outcomePromise = waitForSubmissionOutcome(this.document);
          button.click();
          const outcome = await outcomePromise;
          if (outcome.type === 'success') {
            clickNextItemButton(outcome.nextControl, this.location, this.navigate, true);
            return;
          }
        }

        throw appError('SUBMIT_FAILED', '单选题已尝试所有选项，仍未通过');
      }

      const button = findSubmitButton(this.document);
      if (!button) throw appError('SUBMIT_FAILED', '未找到提交按钮');
      const outcomePromise = waitForSubmissionOutcome(this.document);
      button.click();
      const outcome = await outcomePromise;
      if (outcome.type === 'failure') {
        throw appError('SUBMIT_FAILED', '提交后检测到答案错误，已暂停自动处理，请手动修改答案');
      }
      clickNextItemButton(outcome.nextControl, this.location, this.navigate, true);
    } finally {
      submissionInFlight = false;
    }
  }

  watchSubmissionResult(): void {
    if (this.submissionObserver) return;

    const MutationObserverConstructor = this.document.defaultView?.MutationObserver;
    const root = this.document.body ?? this.document.documentElement;
    if (!MutationObserverConstructor || !root) return;

    // A new submission may reuse the previous question's footer DOM.
    this.document.addEventListener('click', (event) => {
      const target = event.target as Node | null;
      if (target && findSubmitButton(this.document)?.contains(target)) {
        nextItemClicked.delete(this.document);
      }
    }, true);

    const clickIfReady = (): void => {
      if (submissionInFlight) return;
      const nextControl = findSubmissionNextControl(this.document);
      if (nextControl) clickNextItemButton(nextControl, this.location, this.navigate, true);
    };

    clickIfReady();
    this.submissionObserver = new MutationObserverConstructor(clickIfReady);
    this.submissionObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });
  }

  async completeVideo(): Promise<void> {
    const video = this.document.querySelector<HTMLVideoElement>('.fragment-video video')
      ?? this.document.querySelector<HTMLVideoElement>('video');
    if (!video) throw appError('VIDEO_ACTION_FAILED', '未找到视频元素');

    const duration = await waitForVideoDuration(video);
    await seekVideoToEnd(video, Math.max(0, duration - VIDEO_COMPLETION_OFFSET_SECONDS));
    await waitForVideoPlaybackEnd(video, duration);

    const nextControl = findNextVideoControl(this.document);
    if (!nextControl) throw appError('VIDEO_ACTION_FAILED', '未找到视频页面的下一项按钮');
    nextItemClicked.delete(this.document);
    clickNextItemButton(nextControl, this.location, this.navigate);
  }
}
