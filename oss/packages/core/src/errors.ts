// Each code has a fixed HTTP status, so an endpoint can answer with err.status and err.toJSON() (C9).

const STATUS_BY_CODE = {
  INVALID_REQUEST: 400,
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
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof STATUS_BY_CODE;

export interface SlimeErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface SlimeErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  [detail: string]: unknown;
}

export class SlimeError extends Error {
  override readonly name = 'SlimeError';
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    readonly code: ErrorCode,
    message: string,
    { retryable = false, details }: SlimeErrorOptions = {},
  ) {
    super(message);
    this.status = STATUS_BY_CODE[code];
    this.retryable = retryable;
    this.details = details;
  }

  toJSON(): SlimeErrorBody {
    return { ...this.details, code: this.code, message: this.message, retryable: this.retryable };
  }
}

export class SlimeConfigError extends Error {
  override readonly name = 'SlimeConfigError';

  constructor(readonly problems: readonly string[]) {
    super(`Invalid Slime config:\n - ${problems.join('\n - ')}`);
  }
}
