// The Claude adapter against a stubbed fetch (the SDK reads globalThis.fetch
// when the client is built): the shared ModelClient contract, then Claude's
// request shape.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { claudeClient } from '../../src/models/claude/claude-client.js';
import { claude } from '../../src/models/claude/index.js';
import type { GenerationRequest } from '../../src/models/types.js';
import { describeModelClientContract, type ModelScenario } from '../../src/testing/model-contract.js';

const OPTIONS = { apiKey: 'test-key', model: 'claude-haiku-5-5' };
const REQUEST: GenerationRequest = { context: 'Database: postgresql 16', intent: 'all plans', params: {}, output: [{ name: 'string' }] };
const ARTIFACT = { version: 2 as const, unsatisfiable: null, steps: [{ name: 'plans', source: 'db', sql: 'SELECT name FROM plans', params: [] }], shapeJs: null, assumptions: [] };
const KEEP_ALIVE_MS = 1_000;
// The SDK retries 429 and 5xx itself; this keeps its backoff short.
const FAST_RETRY_AFTER = { 'retry-after-ms': '1' };
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function message(value: unknown): Response {
  return Response.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: OPTIONS.model,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  });
}

function apiError(status: number, type: string): Response {
  return Response.json({ type: 'error', error: { type, message: type } }, { status, headers: FAST_RETRY_AFTER });
}

function responseFor(scenario: ModelScenario): Response {
  if (scenario.kind === 'reply') return message(scenario.value);
  if (scenario.kind === 'rate-limited') return apiError(429, 'rate_limit_error');
  if (scenario.kind === 'auth-failed') return apiError(401, 'authentication_error');
  return apiError(529, 'overloaded_error');
}

// A real request's socket keeps the process alive; a stub has to hold a timer.
function hangUntilAborted(_url: string, init: RequestInit): Promise<Response> {
  const keepAlive = setInterval(() => {}, KEEP_ALIVE_MS);
  return new Promise((_resolve, reject) =>
    init.signal?.addEventListener('abort', () => {
      clearInterval(keepAlive);
      reject(init.signal?.reason);
    }),
  );
}

describeModelClientContract('claude', (scenario) => {
  globalThis.fetch = (scenario.kind === 'hang' ? hangUntilAborted : async () => responseFor(scenario)) as typeof fetch;
  return claudeClient(OPTIONS);
});

describe('Claude adapter', () => {
  test('sends the instructions, caches the dictionary and returns the validated artifact', async () => {
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return message(ARTIFACT);
    }) as typeof fetch;
    const result = await claude.generator(OPTIONS).generate(REQUEST, { timeoutMs: 5_000 });
    assert.deepEqual(result.artifact, ARTIFACT);
    const system = sent[0]?.system as { text: string; cache_control?: unknown }[];
    assert.match(system[0]?.text ?? '', /Every parameter may be null/);
    assert.deepEqual([system[1]?.text, system[1]?.cache_control], ['Database: postgresql 16', { type: 'ephemeral' }]);
  });

  test('a missing API key fails with a clear error and sends no request (E2E-13)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => (calls++, message(ARTIFACT))) as typeof fetch;
    // JS callers pass process.env.ANTHROPIC_API_KEY as is, so the key may be undefined.
    for (const apiKey of ['', ' ', undefined as unknown as string]) {
      await assert.rejects(claude.generator({ ...OPTIONS, apiKey }).generate(REQUEST, { timeoutMs: 5_000 }), {
        code: 'GENERATION_FAILED',
        message: 'No Claude API key is set.',
        retryable: false,
      });
    }
    assert.equal(calls, 0);
  });
});
