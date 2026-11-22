// Every call into an API source goes through here: one timeout, one place that
// redacts secrets, one error type the engine classifies (MS16, MS7).
import { redactSecrets } from './redact.js';
import type { SourceCallOptions } from './types.js';

export type SourceMethod = 'describe' | 'safetyCheck' | 'call' | 'close';

export interface SourceCall<T> {
  sourceName: string;
  method: SourceMethod;
  secrets: readonly string[];
  timeoutMs: number;
  /** A caller's signal, for example a sibling step that failed. */
  signal?: AbortSignal;
  run: (options: SourceCallOptions) => Promise<T>;
}

export interface SourceFailure {
  sourceName: string;
  method: SourceMethod;
  /** The HTTP status when the source reported one. */
  status: number | null;
  isRetryable: boolean;
  attempts: number;
  isTimeout: boolean;
  /** Cancelled by the caller's signal, not failed on its own. */
  isAborted: boolean;
}

export class SourceCallError extends Error implements SourceFailure {
  override readonly name = 'SourceCallError';
  readonly sourceName: string;
  readonly method: SourceMethod;
  readonly status: number | null;
  readonly isRetryable: boolean;
  readonly attempts: number;
  readonly isTimeout: boolean;
  readonly isAborted: boolean;

  constructor(message: string, failure: SourceFailure) {
    super(message);
    this.sourceName = failure.sourceName;
    this.method = failure.method;
    this.status = failure.status;
    this.isRetryable = failure.isRetryable;
    this.attempts = failure.attempts;
    this.isTimeout = failure.isTimeout;
    this.isAborted = failure.isAborted;
  }
}

/** Duck-typed so adapters need not import core's SourceError (P4.2). */
interface ReportedFailure {
  message?: unknown;
  status?: unknown;
  isRetryable?: unknown;
  attempts?: unknown;
}

const TOO_MANY_REQUESTS = 429;
const FIRST_SERVER_ERROR = 500;

export async function callSource<T>(call: SourceCall<T>): Promise<T> {
  // A referenced timer, unlike AbortSignal.timeout(): the deadline fires even when nothing else keeps the process alive.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException(`timed out after ${call.timeoutMs} ms`, 'TimeoutError')), call.timeoutMs);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout.signal]) : timeout.signal;
  try {
    return await untilAborted(call.run({ timeoutMs: call.timeoutMs, signal }), signal);
  } catch (error) {
    const isTimeout = timeout.signal.aborted;
    throw toSourceCallError(error, call, { isTimeout, isAborted: call.signal?.aborted === true && !isTimeout });
  } finally {
    clearTimeout(timer);
  }
}

// An adapter that ignores its signal must not hold the request past the deadline.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

interface AbortState {
  isTimeout: boolean;
  isAborted: boolean;
}

function toSourceCallError<T>(error: unknown, call: SourceCall<T>, { isTimeout, isAborted }: AbortState): SourceCallError {
  const reported = (typeof error === 'object' && error !== null ? error : {}) as ReportedFailure;
  const status = typeof reported.status === 'number' ? reported.status : null;
  const isRetryable = typeof reported.isRetryable === 'boolean' ? reported.isRetryable : isTimeout || isRetryableStatus(status);
  const attempts = typeof reported.attempts === 'number' ? reported.attempts : 1;
  const reason = isTimeout ? `timed out after ${call.timeoutMs} ms` : isAborted ? 'cancelled' : String(reported.message ?? error);
  const message = redactSecrets(`${call.sourceName}.${call.method} failed: ${reason}`, call.secrets);
  return new SourceCallError(message, { sourceName: call.sourceName, method: call.method, status, isRetryable, attempts, isTimeout, isAborted });
}

function isRetryableStatus(status: number | null): boolean {
  return status === TOO_MANY_REQUESTS || (status !== null && status >= FIRST_SERVER_ERROR);
}
