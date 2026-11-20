export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'FIELD_NOT_EXPOSED'
  | 'WRITE_REFUSED'
  | 'HANDLER_NOT_FOUND'
  | 'INTENT_UNSATISFIABLE'
  | 'GENERATION_RATE_LIMITED'
  | 'SHAPE_MISMATCH'
  | 'SANDBOX_ERROR'
  | 'QUERY_ERROR'
  | 'QUERY_TOO_EXPENSIVE'
  | 'INVALID_HANDLER'
  | 'GENERATION_FAILED'
  | 'GENERATION_TIMEOUT'
  | 'EXECUTION_TIMEOUT';

const STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  FIELD_NOT_EXPOSED: 403,
  WRITE_REFUSED: 403,
  HANDLER_NOT_FOUND: 404,
  INTENT_UNSATISFIABLE: 422,
  GENERATION_RATE_LIMITED: 429,
  SHAPE_MISMATCH: 500,
  SANDBOX_ERROR: 500,
  QUERY_ERROR: 500,
  QUERY_TOO_EXPENSIVE: 500,
  INVALID_HANDLER: 500,
  GENERATION_FAILED: 502,
  GENERATION_TIMEOUT: 504,
  EXECUTION_TIMEOUT: 504,
};

export class SlimeError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = STATUS[code];
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, ...this.details };
  }
}
