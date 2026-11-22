// The constrained HTTP client (MS10, S1, S2) against a scripted fetch.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHttpClient, type HttpClientOptions } from '../../../../src/sources/api/http/http-client.js';
import type { FetchFunction } from '../../../../src/sources/api/http/retry.js';
import { buildUrl } from '../../../../src/sources/api/http/safe-url.js';
import { SourceError } from '../../../../src/sources/api/source-error.js';

const TOKEN = 'secret_abc123';

interface Recorded {
  url: string;
  init: RequestInit;
}

function scriptedFetch(respond: (url: string) => Response | Promise<Response>): { fetchImpl: FetchFunction; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => (requests.push({ url, init }), respond(url))) as unknown as FetchFunction;
  return { fetchImpl, requests };
}

function client(fetchImpl: FetchFunction, overrides: Partial<HttpClientOptions> = {}) {
  return createHttpClient({ baseUrl: 'https://api.example.com/v1', headers: { authorization: `Bearer ${TOKEN}` }, signal: new AbortController().signal, fetchImpl, ...overrides });
}

const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { status: 200, ...init });

describe('buildUrl (S1)', () => {
  test('appends the path to the base URL and keeps its prefix', () => {
    assert.equal(buildUrl('https://api.example.com/v1/', '/films', { director: 'Hayao Miyazaki', limit: 3, skip: null }).href, 'https://api.example.com/v1/films?director=Hayao+Miyazaki&limit=3');
  });

  test('encodes hostile query values without changing the host', () => {
    for (const value of ['../admin', '?x=1', '#frag', 'https://evil.example/x', '//evil.example']) {
      const url = buildUrl('https://api.example.com', '/films', { director: value });
      assert.equal(url.host, 'api.example.com');
      assert.equal(url.searchParams.get('director'), value);
    }
  });

  test('refuses unsafe paths', () => {
    for (const path of ['//evil.example/x', '/a/../b', '/a/./b', 'films', '/a?x=1', '/a#b', '/a\\b', '/a//b']) {
      assert.throws(() => buildUrl('https://api.example.com', path), SourceError, path);
    }
  });
});

describe('createHttpClient', () => {
  test('sends a GET with the static headers and parses JSON', async () => {
    const { fetchImpl, requests } = scriptedFetch(() => json([{ id: 1 }]));
    assert.deepEqual(await client(fetchImpl).getJson('/films', { director: 'x' }), [{ id: 1 }]);
    assert.equal(requests[0]?.url, 'https://api.example.com/v1/films?director=x');
    assert.equal((requests[0]?.init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
    assert.equal(requests[0]?.init.redirect, 'manual');
  });

  test('sends a POST body as JSON', async () => {
    const { fetchImpl, requests } = scriptedFetch(() => json({ results: [] }));
    await client(fetchImpl).requestJson({ method: 'POST', path: '/query', body: { page_size: 100 } });
    assert.equal(requests[0]?.init.body, '{"page_size":100}');
  });

  test('header values are secrets, and an HTTP error never shows the body', async () => {
    const { fetchImpl } = scriptedFetch(() => new Response(`invalid token ${TOKEN}`, { status: 401 }));
    const http = client(fetchImpl);
    assert.ok(http.secrets.includes(`Bearer ${TOKEN}`));
    await assert.rejects(http.getJson('/films'), (error: SourceError) => error.status === 401 && error.message === 'GET /v1/films answered HTTP 401.');
  });

  test('a network error is redacted', async () => {
    const fetchImpl = (async () => Promise.reject(new Error(`connect failed with Bearer ${TOKEN}`))) as FetchFunction;
    await assert.rejects(client(fetchImpl).getJson('/films'), (error: SourceError) => !error.message.includes(TOKEN) && error.message.includes('[redacted]'));
  });

  test('follows a same-origin redirect and refuses one to another origin', async () => {
    const sameOrigin = scriptedFetch((url) => (url.endsWith('/films') ? new Response(null, { status: 301, headers: { location: '/v1/films/' } }) : json({ moved: true })));
    assert.deepEqual(await client(sameOrigin.fetchImpl).getJson('/films'), { moved: true });
    const crossOrigin = scriptedFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }));
    await assert.rejects(client(crossOrigin.fetchImpl).getJson('/films'), { message: 'Refused a redirect to another origin.' });
    assert.equal(crossOrigin.requests.length, 1, 'the token is never sent to the other origin');
  });

  test('refuses a chunked body over the cap and malformed JSON', async () => {
    const big = scriptedFetch(() => new Response(new ReadableStream({ start: (controller) => (controller.enqueue(new Uint8Array(64)), controller.enqueue(new Uint8Array(64)), controller.close()) })));
    await assert.rejects(client(big.fetchImpl, { maxResponseBytes: 100 }).getJson('/films'), { message: 'The response is larger than 100 bytes.' });
    const broken = scriptedFetch(() => new Response('{not json', { status: 200 }));
    await assert.rejects(client(broken.fetchImpl).getJson('/films'), { message: 'GET /v1/films did not return valid JSON.' });
  });

  test('an unsafe path never reaches fetch', async () => {
    const { fetchImpl, requests } = scriptedFetch(() => json({}));
    await assert.rejects(client(fetchImpl).getJson('//evil.example/x'), SourceError);
    assert.equal(requests.length, 0);
  });
});
