import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fetchWithDeadline, type FetchFunction } from '../../../../src/sources/api/http/retry.js';

function scripted(responses: (() => Response)[]): { fetchImpl: FetchFunction; calls: number } {
  const state = { calls: 0 };
  const fetchImpl = (async () => {
    const next = responses[Math.min(state.calls, responses.length - 1)]!;
    state.calls++;
    return next();
  }) as FetchFunction;
  return Object.assign(state, { fetchImpl });
}

const ok = () => new Response('{"ok":true}', { status: 200 });
const limited = (retryAfter = '0') => () => new Response('slow down', { status: 429, headers: { 'retry-after': retryAfter } });

describe('fetchWithDeadline (MS10)', () => {
  test('returns the first non-429 response and counts attempts', async () => {
    const script = scripted([limited(), limited(), ok]);
    const { response, attempts } = await fetchWithDeadline({ url: 'https://api.example/x', init: {}, signal: new AbortController().signal, fetchImpl: script.fetchImpl });
    assert.equal(response.status, 200);
    assert.equal(attempts, 3);
  });

  test('gives up after the retry limit and returns the 429', async () => {
    const script = scripted([limited()]);
    const { response, attempts } = await fetchWithDeadline({ url: 'https://api.example/x', init: {}, signal: new AbortController().signal, fetchImpl: script.fetchImpl });
    assert.equal(response.status, 429);
    assert.equal(attempts, 6);
  });

  test('the deadline aborts a Retry-After wait', async () => {
    const script = scripted([limited('60'), ok]);
    const signal = AbortSignal.timeout(30);
    await assert.rejects(fetchWithDeadline({ url: 'https://api.example/x', init: {}, signal, fetchImpl: script.fetchImpl }), { name: 'TimeoutError' });
    assert.equal(script.calls, 1);
  });

  test('uses globalThis.fetch when no fetchImpl is given', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = scripted([ok]).fetchImpl;
    try {
      const { response } = await fetchWithDeadline({ url: 'https://api.example/x', init: {}, signal: new AbortController().signal });
      assert.equal(response.status, 200);
    } finally {
      globalThis.fetch = original;
    }
  });
});
