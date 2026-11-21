// The compatibility rule (MS3, docs/multi-source.md §3.3): with no API source
// configured, what Slime sends to a model and returns in meta must not change.
// These pins were recorded on main before any multi-source code; a failing pin
// means a v1 setup would regenerate its handlers or see a different answer.
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { z } from 'zod';
import { SlimeConfig } from '../../src/config/slime-config.js';
import { createSlime } from '../../src/create-slime.js';
import { buildDictionary } from '../../src/dictionary/dictionary.js';
import type { Slime } from '../../src/engine/types.js';
import type { ModelCall, ModelClient, OutputMode } from '../../src/models/model-client.js';
import { modelRoles } from '../../src/models/roles.js';
import type { SchemaInfo } from '../../src/connectors/types.js';
import { canonicalJSON, sha256 } from '../../src/shared/hash.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import { artifact, fakeConnector, stubGenerator } from '../../src/testing/fakes.js';

const SCHEMA: SchemaInfo = {
  dialect: 'postgresql 16',
  tables: [
    {
      name: 'accounts',
      columns: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'text', nullable: false },
        { name: 'plan', type: 'text', nullable: false, values: ['free', 'pro'] },
      ],
      primaryKey: ['id'],
      foreignKeys: [],
    },
  ],
};
const DICTIONARY = buildDictionary({ schema: SCHEMA, glossary: { revenue: 'sum of paid invoices' }, rules: ['Count only paid invoices.'] });
const REQUEST = { context: DICTIONARY.text, intent: 'accounts on a plan', params: { plan: 'string' as const }, output: [{ name: 'string' }] };
const ARTIFACT = artifact('SELECT name FROM accounts WHERE ($1::text IS NULL OR plan = $1::text)', ['plan']);
const HANDLER_KEY = 'fbf5a09c53f41e09ade322803c8e9ab79566013de96196bf7a8703c87ed0b5e5';
const PINS = {
  dictionaryText: '9715f4bd',
  schemaHash: '61412c4f',
  dictionaryHash: '9715f4bd',
  generationNative: 'de449bd9',
  generationPrompt: '5c3d2571',
  reviewNative: '170152bb',
  reviewPrompt: '881a845c',
};

function shortHash(value: unknown): string {
  return sha256(typeof value === 'string' ? value : canonicalJSON(value)).slice(0, 8);
}

/** Records the ModelCall it receives and answers with `reply`. */
function recordingClient(outputMode: OutputMode, reply: unknown): { client: ModelClient; calls: ModelCall<unknown>[] } {
  const calls: ModelCall<unknown>[] = [];
  const client: ModelClient = {
    provider: 'recording',
    model: 'recording-model',
    outputMode,
    call: async <T>(call: ModelCall<T>) => {
      calls.push(call as ModelCall<unknown>);
      return { value: reply as T, usage: { ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 } };
    },
  };
  return { client, calls };
}

function callFingerprint(call: ModelCall<unknown> | undefined): string {
  assert.ok(call, 'the model was called');
  const { instructions, context, message, label } = call;
  return shortHash({ instructions, context, message, label, schema: z.toJSONSchema(call.schema) });
}

describe('v1 compatibility pins (MS3)', () => {
  test('the dictionary text and hashes', () => {
    assert.equal(shortHash(DICTIONARY.text), PINS.dictionaryText);
    assert.equal(DICTIONARY.schemaHash.slice(0, 8), PINS.schemaHash);
    assert.equal(DICTIONARY.hash.slice(0, 8), PINS.dictionaryHash);
  });

  for (const outputMode of ['native', 'prompt'] as const) {
    test(`the generation call (${outputMode} output)`, async () => {
      const { client, calls } = recordingClient(outputMode, ARTIFACT);
      await modelRoles(client).generator.generate(REQUEST, { timeoutMs: 1_000 });
      assert.equal(callFingerprint(calls[0]), outputMode === 'native' ? PINS.generationNative : PINS.generationPrompt);
    });

    test(`the review call (${outputMode} output)`, async () => {
      const { client, calls } = recordingClient(outputMode, { verdict: 'approve', problems: [] });
      await modelRoles(client).reviewer.review({ ...REQUEST, artifact: ARTIFACT }, { timeoutMs: 1_000 });
      assert.equal(callFingerprint(calls[0]), outputMode === 'native' ? PINS.reviewNative : PINS.reviewPrompt);
    });
  }
});

describe('v1 meta pins (MS3)', () => {
  const instances: Slime[] = [];
  after(() => Promise.all(instances.map((slime) => slime.close())));

  for (const isExplore of [true, false]) {
    test(`meta in ${isExplore ? 'explore' : 'locked'} mode has the same fields and values`, async () => {
      const store = memoryStore();
      const connector = fakeConnector({ rows: [{ name: 'Acme' }] });
      const request = { intent: 'accounts on a plan', input: { plan: 'pro' }, output: [{ name: 'string' }] };
      const explore = await createSlime(new SlimeConfig({ connector, store, generator: stubGenerator(() => ARTIFACT), tiers: { gasToLiquidRuns: 1 } }));
      instances.push(explore);
      const generated = await explore.query(request);
      await explore.flush();
      const slime = isExplore ? explore : await createSlime(new SlimeConfig({ connector, store }));
      if (!isExplore) instances.push(slime);
      const { meta } = isExplore ? generated : await slime.query(request);
      const { timingsMs, ...stable } = meta;
      assert.deepEqual(Object.keys(timingsMs).sort(), isExplore ? ['generate', 'run', 'shape', 'total'] : ['run', 'shape', 'total']);
      assert.deepEqual(
        stable,
        isExplore
          ? { handlerKey: HANDLER_KEY, tier: 'liquid', cache: 'miss', truncated: false, warnings: [], review: 'none', sql: ARTIFACT.sql, assumptions: [] }
          : { handlerKey: HANDLER_KEY, tier: 'liquid', cache: 'hit', truncated: false, warnings: [], review: 'none' },
      );
    });
  }
});
