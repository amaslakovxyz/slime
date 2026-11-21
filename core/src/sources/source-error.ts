// What an adapter throws for a failed call. The message must never hold
// headers or a response body; core redacts secrets again on top (MS16).
export interface SourceErrorOptions {
  /** The HTTP status, or null when the request never got one. */
  status?: number | null;
  /** Unset: core decides from the status (429, 5xx and timeouts are retryable, MS7). */
  isRetryable?: boolean;
  attempts?: number;
}

export class SourceError extends Error {
  override readonly name = 'SourceError';
  readonly status: number | null;
  readonly isRetryable: boolean | undefined;
  readonly attempts: number;

  constructor(message: string, { status = null, isRetryable, attempts = 1 }: SourceErrorOptions = {}) {
    super(message);
    this.status = status;
    this.isRetryable = isRetryable;
    this.attempts = attempts;
  }
}
