import type {
  AIAnswer,
  Question,
  QuestionType
} from '../shared/types';

export type CodeFiller = (code: string) => Promise<void>;

export interface SiteAdapter {
  name: string;
  match(): boolean;
  detectQuestionType(): QuestionType;
  extractQuestion(): Question | null;
  fillAnswer(answer: AIAnswer): Promise<void>;
  submitAnswer?(): Promise<void>;
  watchSubmissionResult?(): void;
  completeVideo?(): Promise<void>;
}
