import type { AppError, AppErrorCode } from './types';

export class AppErrorException extends Error implements AppError {
  readonly code: AppErrorCode;
  readonly detail?: string;

  constructor(error: AppError) {
    super(error.message);
    this.name = 'AppErrorException';
    this.code = error.code;
    this.detail = error.detail;
  }
}

export function appError(
  code: AppErrorCode,
  message: string,
  detail?: string
): AppErrorException {
  return new AppErrorException({ code, message, detail });
}
