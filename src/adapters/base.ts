import type {
  AIAnswer,
  Question,
  QuestionType
} from '../shared/types';

export type CodeFiller = (code: string) => Promise<void>;
export type CodeReader = () => Promise<string>;

export interface SiteAdapter {
  name: string;
  match(): boolean;
  detectQuestionType(): QuestionType;
  extractQuestion(): Question | null;
  extractQuestionAsync?(): Promise<Question | null>;
  fillAnswer(answer: AIAnswer): Promise<void>;
  submitAnswer?(): Promise<void>;
  watchSubmissionResult?(): void;
  completeVideo?(): Promise<void>;
}
