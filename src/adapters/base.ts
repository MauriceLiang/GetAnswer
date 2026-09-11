import type {
  AIAnswer,
  Question,
  QuestionType
} from '../shared/types';

export type CodeFiller = (code: string) => Promise<void>;
export type CodeReader = () => Promise<string>;

export interface FillAnswerOptions {
  allowOverwrite?: boolean;
}

export interface SiteAdapter {
  name: string;
  match(): boolean;
  detectQuestionType(): QuestionType;
  isInformationalPage?(): boolean;
  skipInformationalPage?(): void;
  extractQuestion(): Question | null;
  extractQuestionAsync?(): Promise<Question | null>;
  extractAnswer?(): Promise<AIAnswer | null>;
  fillAnswer(answer: AIAnswer, options?: FillAnswerOptions): Promise<void>;
  restoreOriginalProjectFiles?(): Promise<void>;
  submitAnswer?(): Promise<void>;
  watchSubmissionResult?(): void;
  completeVideo?(): Promise<void>;
}
