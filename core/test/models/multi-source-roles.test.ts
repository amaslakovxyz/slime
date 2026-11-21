// modelRoles with a v2 request or a v2 artifact (MS3): the multi-source prompts and schema.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ArtifactV2 } from '../../src/models/artifact-v2.js';
import type { ModelCall, ModelClient, OutputMode } from '../../src/models/model-client.js';
import { MULTI_SOURCE_ARTIFACT_JSON_FORMAT, MULTI_SOURCE_GENERATION_INSTRUCTIONS, MULTI_SOURCE_REVIEW_INSTRUCTIONS } from '../../src/models/prompts-multi-source.js';
import { GENERATION_INSTRUCTIONS } from '../../src/models/prompts.js';
import { modelRoles } from '../../src/models/roles.js';
import { ArtifactSchema, ArtifactV2Schema } from '../../src/models/schemas.js';
import { artifact } from '../../src/testing/fakes.js';

const V2: ArtifactV2 = {
  version: 2,
  unsatisfiable: null,
  steps: [
    { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts WHERE plan = $1::text', params: ['plan'] },
    { name: 'feedback', source: 'notion', operation: 'feedback.query', args: [{ param: 'sentiment', input: null, value: 'negative' }, { param: 'createdFrom', input: 'since', value: null }] },
  ],
  shapeJs: 'function shape(data) { return data.accounts; }',
  assumptions: ['matched by account name'],
};
const REQUEST = { context: 'Database db: postgresql 16', intent: 'accounts with negative feedback', params: { plan: 'string' as const }, output: [{ name: 'string' }] };

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

describe('multi-source model roles (MS3)', () => {
  test('a v2 request sends the multi-source instructions and the v2 schema', async () => {
    const { client, calls } = recording('native', V2);
    const result = await modelRoles(client).generator.generate({ ...REQUEST, format: 'v2' }, { timeoutMs: 1_000 });
    assert.deepEqual(result.artifact, V2);
    assert.equal(calls[0]?.instructions, MULTI_SOURCE_GENERATION_INSTRUCTIONS);
    assert.equal(calls[0]?.schema, ArtifactV2Schema);
  });

  test('prompt-mode providers also get the v2 JSON format', async () => {
    const { client, calls } = recording('prompt', V2);
    await modelRoles(client).generator.generate({ ...REQUEST, format: 'v2' }, { timeoutMs: 1_000 });
    assert.equal(calls[0]?.instructions, `${MULTI_SOURCE_GENERATION_INSTRUCTIONS}\n\n${MULTI_SOURCE_ARTIFACT_JSON_FORMAT}`);
  });

  test('a request without format stays v1', async () => {
    const { client, calls } = recording('native', artifact('SELECT 1'));
    await modelRoles(client).generator.generate(REQUEST, { timeoutMs: 1_000 });
    assert.equal(calls[0]?.instructions, GENERATION_INSTRUCTIONS);
    assert.equal(calls[0]?.schema, ArtifactSchema);
  });

  test('the generator has a separate multi-source prompt hash', () => {
    const { generator } = modelRoles(recording('native', V2).client);
    assert.ok(generator.multiSourcePromptHash);
    assert.notEqual(generator.multiSourcePromptHash, generator.promptHash);
  });

  test('a v2 artifact is reviewed with the multi-source prompt, steps rendered', async () => {
    const { client, calls } = recording('native', { verdict: 'approve', problems: [] });
    await modelRoles(client).reviewer.review({ ...REQUEST, artifact: V2 }, { timeoutMs: 1_000 });
    assert.equal(calls[0]?.instructions, MULTI_SOURCE_REVIEW_INSTRUCTIONS);
    assert.match(calls[0]?.message ?? '', /Step "accounts" \(SQL on db\):\nSELECT name FROM accounts WHERE plan = \$1::text\nparams \(\$1, \$2, \.\.\.\): \["plan"\]/);
    assert.match(calls[0]?.message ?? '', /Step "feedback" \(API notion\): feedback\.query\(sentiment = "negative", createdFrom = input\.since\)/);
  });
});
