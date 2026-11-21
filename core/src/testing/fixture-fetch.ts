// A fetch that replays recorded responses, so adapter and engine tests run with
// no network. Any request without a fixture fails the test, which also proves an
// adapter calls only the endpoints it should (S10).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJSON, sha256 } from '../shared/hash.js';

export interface FixtureRequest {
  method: string;
  url: string;
  body?: unknown;
}

export interface FixtureResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface Fixture {
  request: FixtureRequest;
  response: FixtureResponse;
}

export type FixtureFetch = typeof fetch;

const JSON_SUFFIX = '.json';

/** Origin, method, path and sorted query, plus a hash of the body: two bodies differing only in key order match. */
export function fixtureKey({ method, url, body }: FixtureRequest): string {
  const parsed = new URL(url);
  parsed.searchParams.sort();
  const bodyHash = body === undefined || body === null ? '' : ` ${sha256(canonicalJSON(body)).slice(0, 16)}`;
  return `${method.toUpperCase()} ${parsed.origin}${parsed.pathname}${parsed.search}${bodyHash}`;
}

export function fixtureFetch(dir: string | URL): FixtureFetch {
  const folder = typeof dir === 'string' ? dir : fileURLToPath(dir);
  const fixtures = new Map<string, FixtureResponse>();
  for (const file of readdirSync(folder).filter((name) => name.endsWith(JSON_SUFFIX))) {
    const fixture = JSON.parse(readFileSync(join(folder, file), 'utf8')) as Fixture;
    fixtures.set(fixtureKey(fixture.request), fixture.response);
  }
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const key = fixtureKey({ method: init.method ?? 'GET', url, body });
    const response = fixtures.get(key);
    if (!response) throw new Error(`No fixture for ${key}`);
    if (init.signal?.aborted) throw init.signal.reason;
    return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers ?? {} });
  }) as FixtureFetch;
}
