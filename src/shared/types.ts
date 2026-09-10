export type QuestionType = 'programming' | 'project' | 'choice' | 'fill' | 'unknown';

export type ChoiceSelectionMode = 'single' | 'multiple';

export interface ExampleCase {
  input?: string;
  output?: string;
}

export interface ChoiceOption {
  key: string;
  text: string;
}

export interface Question {
  id?: string;
  type: QuestionType;
  title?: string;
  content: string;
  requirements?: string;
  examples?: ExampleCase[];
  language?: string;
  editorCode?: string;
  files?: ProjectFile[];
  selectionMode?: ChoiceSelectionMode;
  options?: ChoiceOption[];
  blankCount?: number;
}

export interface ProgrammingAnswer {
  type: 'programming';
  code: string;
}

export interface ChoiceAnswer {
  type: 'choice';
  selections: string[];
}

export interface FillAnswer {
  type: 'fill';
  values: string[];
}

export interface ProjectFile {
  path: string;
  code: string;
  editable: boolean;
}

export interface ProjectAnswerFile {
  path: string;
  code: string;
}

export interface ProjectAnswer {
  type: 'project';
  files: ProjectAnswerFile[];
}

export type AIAnswer = ProgrammingAnswer | ProjectAnswer | ChoiceAnswer | FillAnswer;

export interface PageContext {
  adapter: string;
  supported: boolean;
  question?: Question;
  hasVideo: boolean;
  videoSrc?: string;
  hasEditor: boolean;
}

export interface AIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeout: number;
  autoSubmit: boolean;
  autoSolve: boolean;
  autoAdvanceVideo: boolean;
}

export type AppErrorCode =
  | 'PAGE_NOT_SUPPORTED'
  | 'QUESTION_NOT_FOUND'
  | 'QUESTION_TYPE_UNKNOWN'
  | 'EDITOR_NOT_FOUND'
  | 'EDITOR_WRITE_FAILED'
  | 'AI_CONFIG_INVALID'
  | 'AI_REQUEST_FAILED'
  | 'AI_RESPONSE_INVALID'
  | 'SUBMIT_FAILED'
  | 'VIDEO_ACTION_FAILED'
  | 'PAGE_REFRESH_FAILED';

export interface AppError {
  code: AppErrorCode;
  message: string;
  detail?: string;
}

export type TaskStatus =
  | 'idle'
  | 'scanning'
  | 'requesting'
  | 'filling'
  | 'complete'
  | 'error';
