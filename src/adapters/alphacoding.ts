import type {
  AIAnswer,
  ChoiceOption,
  ExampleCase,
  Question,
  QuestionType
} from '../shared/types';
import { appError } from '../shared/errors';
import type { CodeFiller, SiteAdapter } from './base';

const SUBMIT_RESULT_TIMEOUT_MS = 10_000;
const VIDEO_METADATA_TIMEOUT_MS = 10_000;
const VIDEO_SEEK_TIMEOUT_MS = 10_000;
const NEXT_NAVIGATION_FALLBACK_MS = 300;
const nextItemClicked = new WeakSet<Document>();
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

function findNextVideoControl(document: Document): HTMLElement | null {
  const nextLink = Array.from(
    document.querySelectorAll<HTMLElement>('.lesson-footer-nav a, .lesson-footer-nav button')
  ).find((link) => textOf(link).includes('下一项')
    && !link.matches(':disabled, [aria-disabled="true"]')
    && isVisible(link, document.defaultView));
  return nextLink ?? null;
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

function findNextItemButton(document: Document): HTMLButtonElement | null {
  const view = document.defaultView;
  const resultWrappers = Array.from(
    document.querySelectorAll<HTMLElement>('.el-dialog__body, [role="dialog"], .el-overlay-dialog')
  );

  for (const wrapper of resultWrappers) {
    const hasSuccessMarker = wrapper.querySelector(
      '.submit-result-wrap, .success-header, .fa-check-circle, .fa-check, [class*="success"]'
    ) !== null || /(?:回答正确|全部通过|恭喜)/.test(textOf(wrapper));
    if (!hasSuccessMarker || !isVisible(wrapper, view)) continue;

    const nextButton = Array.from(
      wrapper.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => textOf(button).includes('下一项'));
    if (nextButton && isVisible(nextButton, view)) return nextButton;
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

function hasSubmissionFailure(document: Document): boolean {
  const view = document.defaultView;
  const failurePattern = /作答错误|回答错误|答案错误|不正确|未通过/;
  return Array.from(document.querySelectorAll(
    '.check-result-status, .el-dialog__body, [role="dialog"], .el-overlay-dialog'
  )).some((result) => isVisible(result, view) && failurePattern.test(textOf(result)));
}

const submissionResultSelector =
  '.check-result-status, .el-dialog__body, [role="dialog"], .el-overlay-dialog';

function isSubmissionResultNode(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return element?.matches(submissionResultSelector) === true
    || element?.closest(submissionResultSelector) !== null;
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
  const dialogButton = findNextItemButton(document);
  if (dialogButton) return dialogButton;
  return hasInlineSubmissionResult(document) ? findNextVideoControl(document) : null;
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

function findSubmitButton(document: Document): HTMLButtonElement | null {
  const programmingButton = document.querySelector<HTMLButtonElement>('.submit-btn button');
  if (programmingButton) return programmingButton;

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
  navigate: (url: string) => void
): void {
  const document = control.ownerDocument;
  if (nextItemClicked.has(document)) return;
  nextItemClicked.add(document);

  const targetUrl = nextNavigationTarget(control, location);
  const pathBeforeClick = currentPath(location);
  control.click();

  if (!targetUrl) return;
  setTimeout(() => {
    if (currentPath(location) === pathBeforeClick) navigate(targetUrl);
  }, NEXT_NAVIGATION_FALLBACK_MS);
}

export class AlphaCodingAdapter implements SiteAdapter {
  name = 'alphacoding';
  private submissionObserver?: MutationObserver;

  constructor(
    private readonly document: Document,
    private readonly location: Location,
    private readonly fillCode: CodeFiller = defaultFillCode,
    private readonly navigate: (url: string) => void = (url) => location.assign(url)
  ) {}

  match(): boolean {
    return this.location.hostname === 'nuc.alphacoding.cn';
  }

  detectQuestionType(): QuestionType {
    const typeName = textOf(this.document.querySelector('.exercise-type-name'));
    if (typeName === '编程题') return 'programming';
    if (typeName.includes('填空') && fillInputs(this.document).length > 0) return 'fill';
    if (/(?:选择|单选|多选|判断)题?/.test(typeName) && choiceInputs(this.document).length > 0) {
      return 'choice';
    }
    return 'unknown';
  }

  extractQuestion(): Question | null {
    const type = this.detectQuestionType();
    if (type !== 'programming' && type !== 'choice' && type !== 'fill') return null;

    const content = extractQuestionContent(this.document, type);
    if (!content) return null;

    const title = textOf(
      this.document.querySelector('.exercise-content h2, .lesson-title h1')
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

  async fillAnswer(answer: AIAnswer): Promise<void> {
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
            clickNextItemButton(outcome.nextControl, this.location, this.navigate);
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
      clickNextItemButton(outcome.nextControl, this.location, this.navigate);
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
      if (nextControl) clickNextItemButton(nextControl, this.location, this.navigate);
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
    await seekVideoToEnd(video, duration);

    const nextControl = findNextVideoControl(this.document);
    if (!nextControl) throw appError('VIDEO_ACTION_FAILED', '未找到视频页面的下一项按钮');
    nextItemClicked.delete(this.document);
    clickNextItemButton(nextControl, this.location, this.navigate);
  }
}
