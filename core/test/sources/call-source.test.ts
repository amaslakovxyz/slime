import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SourceCallError, callSource } from '../../src/sources/call-source.js';
import { redactSecrets } from '../../src/sources/redact.js';

const SECRET = 'secret-token-123';
const base = { sourceName: 'notion', method: 'call' as const, secrets: [SECRET], timeoutMs: 1_000 };

async function failure(run: Parameters<typeof callSource>[0]['run'], overrides: Partial<Parameters<typeof callSource>[0]> = {}): Promise<SourceCallError> {
  try {
    await callSource({ ...base, ...overrides, run });
  } catch (error) {
    assert.ok(error instanceof SourceCallError);
    return error;
  }
  assert.fail('expected a SourceCallError');
}

describe('redactSecrets (MS16)', () => {
  test('removes every secret, longer ones first', () => {
    assert.equal(redactSecrets('a abc b ab', ['ab', 'abc', '']), 'a [redacted] b [redacted]');
  });
});

describe('callSource (MS16, MS7)', () => {
  test('returns the result and passes the timeout and a signal', async () => {
    const result = await callSource({ ...base, run: async ({ timeoutMs, signal }) => ({ timeoutMs, isAborted: signal.aborted }) });
    assert.deepEqual(result, { timeoutMs: 1_000, isAborted: false });
  });

  test('a failure is wrapped, named, and has no secret in its message', async () => {
    const error = await failure(async () => {
      throw Object.assign(new Error(`401 for Bearer ${SECRET}`), { status: 401 });
    });
    assert.equal(error.message, 'notion.call failed: 401 for Bearer [redacted]');
    assert.equal(error.status, 401);
    assert.equal(error.isRetryable, false);
    assert.equal(error.isAborted, false);
  });

  test('429 and 5xx are retryable unless the adapter says otherwise', async () => {
    assert.equal((await failure(async () => Promise.reject(Object.assign(new Error('slow down'), { status: 429 })))).isRetryable, true);
    assert.equal((await failure(async () => Promise.reject(Object.assign(new Error('down'), { status: 503 })))).isRetryable, true);
    assert.equal((await failure(async () => Promise.reject(Object.assign(new Error('down'), { status: 503, isRetryable: false })))).isRetryable, false);
  });

  test('an adapter that ignores its signal still times out', async () => {
    const error = await failure(() => new Promise(() => {}), { timeoutMs: 20 });
    assert.equal(error.isTimeout, true);
    assert.equal(error.isRetryable, true);
    assert.match(error.message, /timed out after 20 ms/);
  });

  test("the caller's signal cancels the call and marks it aborted", async () => {
    const controller = new AbortController();
    const pending = failure(() => new Promise(() => {}), { signal: controller.signal });
    controller.abort();
    const error = await pending;
    assert.equal(error.isAborted, true);
    assert.equal(error.isTimeout, false);
  });
});
