// modelRoles: every provider gets the same prompts and schema; only the transport differs.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Artifact } from '../../src/artifact/artifact.js';
import type { ModelCall, ModelClient, OutputMode } from '../../src/models/model-client.js';
import { ARTIFACT_JSON_FORMAT, GENERATION_INSTRUCTIONS, REVIEW_INSTRUCTIONS } from '../../src/models/prompts.js';
import { modelRoles, providerRoles } from '../../src/models/roles.js';
import { ArtifactSchema } from '../../src/models/schemas.js';

const ARTIFACT: Artifact = {
  version: 2,
  unsatisfiable: null,
  steps: [
    { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts WHERE plan = $1::text', params: ['plan'] },
    { name: 'feedback', source: 'notion', operation: 'feedback.query', args: [{ param: 'sentiment', input: null, value: 'negative' }, { param: 'createdFrom', input: 'since', value: null }] },
  ],
  shapeJs: 'function shape(data) { return data.accounts; }',
  assumptions: ['matched by account name'],
};
const REQUEST = { context: 'Database source "db": postgresql 16', intent: 'accounts with negative feedback', params: { plan: 'string' as const }, output: [{ name: 'string' }] };

function recording(outputMode: OutputMode, reply: unknown): { client: ModelClient; calls: ModelCall<unknown>[] } {
  const calls: ModelCall<unknown>[] = [];
  return {
    calls,
    client: {
      provider: 'recording',
      model: 'm',
      outputMode,
      call: async <T>(call: ModelCall<T>) => (calls.push(call as ModelCall<unknown>), { value: reply as T, usage: { ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 } }),
    },
  };
}

describe('model roles', () => {
  test('generation sends the shared instructions and schema', async () => {
    const { client, calls } = recording('native', ARTIFACT);
    const result = await modelRoles(client).generator.generate(REQUEST, { timeoutMs: 1_000 });
    assert.deepEqual(result.artifact, ARTIFACT);
    assert.equal(calls[0]?.instructions, GENERATION_INSTRUCTIONS);
    assert.equal(calls[0]?.schema, ArtifactSchema);
  });

  test('prompt-mode providers also get the JSON format spelled out', async () => {
    const { client, calls } = recording('prompt', ARTIFACT);
    await modelRoles(client).generator.generate(REQUEST, { timeoutMs: 1_000 });
    assert.equal(calls[0]?.instructions, `${GENERATION_INSTRUCTIONS}\n\n${ARTIFACT_JSON_FORMAT}`);
  });

  test('the prompt hash depends on the provider and output mode, not on the model', () => {
    const hash = (provider: string, outputMode: OutputMode, model = 'm'): string => modelRoles({ ...recording(outputMode, ARTIFACT).client, provider, model }).generator.promptHash;
    assert.equal(hash('a', 'native', 'one'), hash('a', 'native', 'two'));
    assert.notEqual(hash('a', 'native'), hash('b', 'native'));
    assert.notEqual(hash('a', 'native'), hash('a', 'prompt'));
  });

  test('the reviewer renders every step', async () => {
    const { client, calls } = recording('native', { verdict: 'approve', problems: [] });
    await modelRoles(client).reviewer.review({ ...REQUEST, artifact: ARTIFACT }, { timeoutMs: 1_000 });
    assert.equal(calls[0]?.instructions, REVIEW_INSTRUCTIONS);
    assert.match(calls[0]?.message ?? '', /Step "accounts" \(SQL on db\):\nSELECT name FROM accounts WHERE plan = \$1::text\nparams \(\$1, \$2, \.\.\.\): \["plan"\]/);
    assert.match(calls[0]?.message ?? '', /Step "feedback" \(API notion\): feedback\.query\(sentiment = "negative", createdFrom = input\.since\)/);
  });

  test('providerRoles builds each role from the client factory', async () => {
    const { client, calls } = recording('native', ARTIFACT);
    const provider = providerRoles((options: { model: string }) => ({ ...client, model: options.model }));
    const generator = provider.generator({ model: 'big' });
    await generator.generate(REQUEST, { timeoutMs: 1_000 });
    assert.equal(generator.model, 'big');
    assert.equal(provider.reviewer({ model: 'small' }).model, 'small');
    assert.equal(calls.length, 1);
  });
});
