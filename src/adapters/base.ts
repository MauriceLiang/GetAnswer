import type {
  AIAnswer,
  Question,
  QuestionType
} from '../shared/types';

export type CodeFiller = (code: string, signal?: AbortSignal) => Promise<void>;
export type CodeReader = (signal?: AbortSignal) => Promise<string>;

export interface FillAnswerOptions {
  allowOverwrite?: boolean;
  signal?: AbortSignal;
}

export interface SiteAdapter {
  name: string;
  match(): boolean;
  detectQuestionType(): QuestionType;
  isInformationalPage?(): boolean;
  skipInformationalPage?(): void;
  extractQuestion(): Question | null;
  extractQuestionAsync?(signal?: AbortSignal): Promise<Question | null>;
  extractAnswer?(): Promise<AIAnswer | null>;
  fillAnswer(answer: AIAnswer, options?: FillAnswerOptions): Promise<void>;
  restoreOriginalProjectFiles?(): Promise<void>;
  submitAnswer?(): Promise<void>;
  watchSubmissionResult?(): void;
  stopSubmissionResultWatcher?(): void;
  completeVideo?(): Promise<void>;
}
