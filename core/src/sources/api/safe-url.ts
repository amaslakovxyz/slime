// Every adapter request URL is built here, so a model-bound argument can never
// change the host the token is sent to (S1, MS10).
import { SourceError } from '../source-error.js';

// One leading slash, then unreserved and a few sub-delims; no '?', '#' or '\'.
const SAFE_PATH = /^\/[A-Za-z0-9\-._~%:@/]*$/;
const DOUBLE_SLASH = '//';
const PARENT_SEGMENT = /(^|\/)\.\.?(\/|$)/;

export type QueryValue = string | number | boolean | null | undefined;

export function buildUrl(baseUrl: string, path: string, query: Readonly<Record<string, QueryValue>> = {}): URL {
  if (!SAFE_PATH.test(path) || path.includes(DOUBLE_SLASH) || PARENT_SEGMENT.test(path)) {
    throw new SourceError(`Refused an unsafe request path "${path}".`, { isRetryable: false });
  }
  const base = new URL(baseUrl);
  const url = new URL(base.href);
  // Appended, so a base URL with a path prefix (https://host/api/v1) keeps it.
  url.pathname = `${base.pathname.replace(/\/+$/, '')}${path}`;
  url.search = '';
  for (const [name, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) url.searchParams.set(name, String(value));
  }
  if (url.origin !== base.origin) throw new SourceError('Refused a request to another origin.', { isRetryable: false });
  return url;
}

export function isSameOrigin(target: URL, base: URL): boolean {
  return target.origin === base.origin;
}
