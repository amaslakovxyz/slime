// One deadline for every attempt of an API call (MS10). Unlike the Groq client,
// which gives each attempt its own timeout, a source call must finish inside
// apiTimeoutMs however many 429s it meets.
const TOO_MANY_REQUESTS = 429;
const MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_MAX_RETRY_WAIT_MS = 30_000;
const DEFAULT_RETRY_WAIT_MS = 1_000;
const MS_PER_SECOND = 1_000;

export type FetchFunction = typeof fetch;

export interface DeadlineFetch {
  url: string;
  init: RequestInit;
  /** Aborts the request and any wait between attempts. */
  signal: AbortSignal;
  maxRetryWaitMs?: number;
  /** Read at call time, so tests can swap globalThis.fetch. */
  fetchImpl?: FetchFunction;
}

export interface FetchOutcome {
  response: Response;
  attempts: number;
}

export async function fetchWithDeadline({ url, init, signal, maxRetryWaitMs = DEFAULT_MAX_RETRY_WAIT_MS, fetchImpl }: DeadlineFetch): Promise<FetchOutcome> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  for (let attempts = 1; ; attempts++) {
    const response = await doFetch(url, { ...init, signal });
    if (response.status !== TOO_MANY_REQUESTS || attempts > MAX_RATE_LIMIT_RETRIES) return { response, attempts };
    await response.body?.cancel();
    await abortableWait(Math.min(retryAfterMs(response), maxRetryWaitMs), signal);
  }
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get('retry-after');
  if (!header) return DEFAULT_RETRY_WAIT_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * MS_PER_SECOND);
  const at = Date.parse(header);
  return Number.isNaN(at) ? DEFAULT_RETRY_WAIT_MS : Math.max(0, at - Date.now());
}

function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
