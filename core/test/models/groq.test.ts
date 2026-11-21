// The Groq adapter against a stubbed fetch: the shared ModelClient contract, then
// Groq's request shape and rate-limit waits.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { SlimeError } from '../../src/shared/errors.js';
import { groqClient } from '../../src/models/groq/groq-client.js';
import { groq } from '../../src/models/groq/index.js';
import { describeModelClientContract, type ModelScenario } from '../../src/testing/model-contract.js';
import type { GenerationRequest } from '../../src/models/types.js';

const OPTIONS = { apiKey: 'test-key', model: 'openai/gpt-oss-120b', reasoningEffort: 'low' as const };
const REQUEST: GenerationRequest = { context: 'Database: postgresql 16', intent: 'all plans', params: {}, output: [{ name: 'string' }] };
const ARTIFACT = { unsatisfiable: null, sql: 'SELECT name FROM plans', params: [], shapeJs: null, assumptions: [] };
const CALL = { timeoutMs: 5_000 };
const realFetch = globalThis.fetch;

interface SentRequest {
  url: string;
  body: Record<string, unknown>;
  authorization: string | null;
}

function stubFetch(responses: Response[]): SentRequest[] {
  const sent: SentRequest[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)), authorization: new Headers(init.headers).get('authorization') });
    return responses.shift() ?? new Response('no more responses', { status: 500 });
  }) as typeof fetch;
  return sent;
}

const completion = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));

afterEach(() => {
  globalThis.fetch = realFetch;
});

// Retries are part of the adapter, so each scenario answers every attempt the same way.
const FAST_RETRY_AFTER = { 'retry-after': '0.001' };

function responseFor(scenario: ModelScenario): Response {
  if (scenario.kind === 'reply') return completion(scenario.value);
  if (scenario.kind === 'rate-limited') return new Response('slow down', { status: 429, headers: FAST_RETRY_AFTER });
  if (scenario.kind === 'auth-failed') return new Response('unauthorized', { status: 401 });
  return new Response('upstream failed', { status: 503 });
}

const KEEP_ALIVE_MS = 1_000;

// A real request's socket keeps the process alive; AbortSignal.timeout's timer does not, so hold one.
function hangUntilAborted(_url: string, init: RequestInit): Promise<Response> {
  const keepAlive = setInterval(() => {}, KEEP_ALIVE_MS);
  return new Promise((_resolve, reject) =>
    init.signal?.addEventListener('abort', () => {
      clearInterval(keepAlive);
      reject(init.signal?.reason);
    }),
  );
}

describeModelClientContract('groq', (scenario) => {
  globalThis.fetch = (scenario.kind === 'hang' ? hangUntilAborted : async () => responseFor(scenario)) as typeof fetch;
  return groqClient(OPTIONS);
});

describe('Groq adapter (M4)', () => {
  test('sends the prompt, dictionary and request in JSON mode and returns the validated artifact', async () => {
    const sent = stubFetch([completion(ARTIFACT)]);
    const result = await groq.generator(OPTIONS).generate(REQUEST, CALL);
    assert.deepEqual(result.artifact, ARTIFACT);
    assert.deepEqual([result.inputTokens, result.outputTokens], [100, 20]);
    const [request] = sent;
    assert.equal(request?.authorization, 'Bearer test-key');
    assert.deepEqual([request?.body.model, request?.body.response_format, request?.body.reasoning_effort], [OPTIONS.model, { type: 'json_object' }, 'low']);
    const [system, user] = request?.body.messages as { content: string }[];
    assert.match(system?.content ?? '', /Every parameter may be null[\s\S]*Database: postgresql 16$/);
    assert.match(user?.content ?? '', /^Intent: all plans/);
  });

  test('the prompt hash is stable and differs between generator prompts', () => {
    assert.equal(groq.generator(OPTIONS).promptHash, groq.generator({ ...OPTIONS, model: 'other' }).promptHash);
    assert.match(groq.generator(OPTIONS).promptHash, /^[0-9a-f]{16}$/);
  });

  test('waits out a 429 and reports the wait separately from model time', async () => {
    stubFetch([new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } }), completion(ARTIFACT)]);
    const result = await groq.generator(OPTIONS).generate(REQUEST, CALL);
    assert.ok(result.waitMs > 0);
  });

  test('the reviewer returns a validated verdict', async () => {
    stubFetch([completion({ verdict: 'reject', problems: ['wrong sort direction'] })]);
    const review = await groq.reviewer(OPTIONS).review({ ...REQUEST, artifact: ARTIFACT }, CALL);
    assert.deepEqual([review.verdict, review.problems], ['reject', ['wrong sort direction']]);
  });
});
