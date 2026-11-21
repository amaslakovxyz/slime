// The ModelClient contract. Every model provider, built in or custom, must pass
// it. The provider's own test turns each scenario into a stubbed transport (a
// fake fetch, a mocked SDK), so the contract never calls a real model.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import type { ModelCall, ModelClient } from '../models/model-client.js';
import { SlimeError, type ErrorCode } from '../shared/errors.js';

/** What the stubbed provider does for every attempt of one call. */
export type ModelScenario =
  /** Answers with this JSON value as the model's reply. */
  | { kind: 'reply'; value: unknown }
  | { kind: 'rate-limited' }
  | { kind: 'auth-failed' }
  /** A 5xx or the provider's equivalent. */
  | { kind: 'server-error' }
  /** Never answers until the call is aborted or times out. */
  | { kind: 'hang' };

export type ModelClientFactory = (scenario: ModelScenario) => ModelClient | Promise<ModelClient>;

export interface ModelContractOptions {
  /** Called once before each test, for example to reset a stubbed fetch. */
  beforeEach?: () => void;
}

interface ExpectedFailure {
  code: ErrorCode;
  isRetryable: boolean;
}

const ANSWER_SCHEMA = z.object({ answer: z.string(), count: z.number() });
const ANSWER = { answer: 'forty-two', count: 42 };
const WRONG_FIELDS = { answer: 42 };
const TIMEOUT_MS = 5_000;
const SHORT_TIMEOUT_MS = 100;
const ABORT_AFTER_MS = 50;
const OUTPUT_MODES = ['native', 'prompt'];

function contractCall(overrides: Partial<ModelCall<z.infer<typeof ANSWER_SCHEMA>>> = {}): ModelCall<z.infer<typeof ANSWER_SCHEMA>> {
  return { instructions: 'Answer in JSON.', context: 'contract test', message: 'What is the answer?', schema: ANSWER_SCHEMA, timeoutMs: TIMEOUT_MS, label: 'contract', ...overrides };
}

async function assertFails(pending: Promise<unknown>, expected: ExpectedFailure): Promise<void> {
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof SlimeError, `a SlimeError, not ${String(error)}`);
    assert.deepEqual({ code: error.code, isRetryable: error.retryable }, expected);
    return true;
  });
}

export function describeModelClientContract(providerName: string, createClient: ModelClientFactory, options: ModelContractOptions = {}): void {
  const clientFor = async (scenario: ModelScenario) => {
    options.beforeEach?.();
    return createClient(scenario);
  };

  describe(`${providerName} model client: ModelClient contract`, () => {
    test('names its provider, model and output mode', async () => {
      const client = await clientFor({ kind: 'reply', value: ANSWER });
      assert.ok(client.provider.length > 0 && client.model.length > 0);
      assert.ok(OUTPUT_MODES.includes(client.outputMode), client.outputMode);
    });

    test('returns the reply validated against the schema, with usage', async () => {
      const client = await clientFor({ kind: 'reply', value: ANSWER });
      const { value, usage } = await client.call(contractCall());
      assert.deepEqual(value, ANSWER);
      for (const [field, amount] of Object.entries(usage)) assert.ok(Number.isFinite(amount) && amount >= 0, `${field}: ${amount}`);
    });

    test('a reply with wrong fields is a retryable GENERATION_FAILED', async () => {
      const client = await clientFor({ kind: 'reply', value: WRONG_FIELDS });
      await assertFails(client.call(contractCall()), { code: 'GENERATION_FAILED', isRetryable: true });
    });

    test('a rate limit is a retryable GENERATION_RATE_LIMITED', async () => {
      const client = await clientFor({ kind: 'rate-limited' });
      await assertFails(client.call(contractCall()), { code: 'GENERATION_RATE_LIMITED', isRetryable: true });
    });

    test('a rejected API key is a final GENERATION_FAILED', async () => {
      const client = await clientFor({ kind: 'auth-failed' });
      await assertFails(client.call(contractCall()), { code: 'GENERATION_FAILED', isRetryable: false });
    });

    test('a server error is a retryable GENERATION_FAILED', async () => {
      const client = await clientFor({ kind: 'server-error' });
      await assertFails(client.call(contractCall()), { code: 'GENERATION_FAILED', isRetryable: true });
    });

    test('a call over timeoutMs is a retryable GENERATION_TIMEOUT', async () => {
      const client = await clientFor({ kind: 'hang' });
      await assertFails(client.call(contractCall({ timeoutMs: SHORT_TIMEOUT_MS })), { code: 'GENERATION_TIMEOUT', isRetryable: true });
    });

    test('an aborted signal stops the call with a final SlimeError', async () => {
      const client = await clientFor({ kind: 'hang' });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ABORT_AFTER_MS);
      await assert.rejects(client.call(contractCall({ signal: controller.signal })), (error: unknown) => {
        assert.ok(error instanceof SlimeError, `a SlimeError, not ${String(error)}`);
        assert.equal(error.retryable, false);
        return true;
      });
    });
  });
}
