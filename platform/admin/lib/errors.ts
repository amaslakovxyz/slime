// Errors the UI maps to a message; `code` is the stable part, `message` is user-facing.
export class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CodedError';
  }
}

export const hasCode = (err: unknown, code: string): boolean => err instanceof CodedError && err.code === code;
