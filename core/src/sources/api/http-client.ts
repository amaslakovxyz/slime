// The only way an API adapter reaches the network (MS10, Q8): fixed base URL,
// safe paths, same-origin redirects, one deadline, a size cap, and errors with
// no headers, bodies or secrets in them (S1, S2).
import { redactSecrets } from '../redact.js';
import { SourceError } from '../source-error.js';
import { readCapped } from './read-capped.js';
import { fetchWithDeadline, type FetchFunction } from './retry.js';
import { buildUrl, isSameOrigin, type QueryValue } from './safe-url.js';

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FIRST_REDIRECT = 300;
const FIRST_NON_REDIRECT = 400;
const JSON_TYPE = 'application/json';

export interface HttpClientOptions {
  baseUrl: string;
  /** Static headers such as Authorization; every value is treated as a secret (MS16). */
  headers?: Readonly<Record<string, string>>;
  secrets?: readonly string[];
  /** The call's deadline and cancellation. */
  signal: AbortSignal;
  fetchImpl?: FetchFunction;
  maxResponseBytes?: number;
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  path: string;
  query?: Readonly<Record<string, QueryValue>>;
  body?: unknown;
}

export interface HttpClient {
  getJson<T = unknown>(path: string, query?: Readonly<Record<string, QueryValue>>): Promise<T>;
  requestJson<T = unknown>(request: HttpRequestOptions): Promise<T>;
  /** The declared secrets plus every header value. */
  readonly secrets: readonly string[];
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const secrets = Object.freeze([...(options.secrets ?? []), ...Object.values(options.headers ?? {})]);
  const requestJson = async <T>(request: HttpRequestOptions): Promise<T> => {
    try {
      return (await sendJson(options, request)) as T;
    } catch (error) {
      throw asRedactedSourceError(error, secrets);
    }
  };
  return { secrets, requestJson, getJson: (path, query) => requestJson({ path, ...(query ? { query } : {}) }) };
}

async function sendJson(options: HttpClientOptions, { method = 'GET', path, query, body }: HttpRequestOptions): Promise<unknown> {
  const base = new URL(options.baseUrl);
  let url = buildUrl(options.baseUrl, path, query);
  const init: RequestInit = {
    method,
    redirect: 'manual',
    headers: { accept: JSON_TYPE, ...(body === undefined ? {} : { 'content-type': JSON_TYPE }), ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  let attempts = 0;
  for (let redirects = 0; ; redirects++) {
    const outcome = await fetchWithDeadline({ url: url.href, init, signal: options.signal, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    attempts += outcome.attempts;
    const { response } = outcome;
    if (!isRedirect(response.status)) return parseJson(response, `${method} ${url.pathname}`, attempts, options.maxResponseBytes ?? MAX_RESPONSE_BYTES);
    await response.body?.cancel();
    url = redirectTarget(response, url, base, redirects);
  }
}

function isRedirect(status: number): boolean {
  return status >= FIRST_REDIRECT && status < FIRST_NON_REDIRECT;
}

function redirectTarget(response: Response, current: URL, base: URL, redirects: number): URL {
  const location = response.headers.get('location');
  if (!location || redirects >= MAX_REDIRECTS) throw new SourceError(`Too many redirects, or a redirect without a target (HTTP ${response.status}).`, { status: response.status, isRetryable: false });
  const target = new URL(location, current);
  if (!isSameOrigin(target, base)) throw new SourceError('Refused a redirect to another origin.', { status: response.status, isRetryable: false });
  return target;
}

// The body is read only for success: an error body could echo the request, headers included.
async function parseJson(response: Response, label: string, attempts: number, maxBytes: number): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new SourceError(`${label} answered HTTP ${response.status}.`, { status: response.status, attempts });
  }
  const text = await readCapped(response, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError(`${label} did not return valid JSON.`, { status: response.status, isRetryable: false, attempts });
  }
}

function asRedactedSourceError(error: unknown, secrets: readonly string[]): unknown {
  if (error instanceof SourceError) return new SourceError(redactSecrets(error.message, secrets), errorOptions(error));
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return error;
  return new SourceError(redactSecrets(`The request failed: ${error instanceof Error ? error.message : String(error)}`, secrets));
}

function errorOptions({ status, isRetryable, attempts }: SourceError) {
  return { status, attempts, ...(isRetryable === undefined ? {} : { isRetryable }) };
}
