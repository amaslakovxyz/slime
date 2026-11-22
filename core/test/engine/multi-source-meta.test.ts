// Multi-source generation through the engine and its meta (R9).
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { SlimeConfig, type SlimeOptions } from '../../src/config/slime-config.js';
import type { SlimeEvent } from '../../src/config/events.js';
import { createSlime } from '../../src/create-slime.js';
import type { Slime } from '../../src/engine/types.js';
import type { Artifact } from '../../src/artifact/artifact.js';
import type { GenerationRequest } from '../../src/models/types.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import type { SlimeStore } from '../../src/stores/types.js';
import { fakeApiSource } from '../../src/testing/fake-api-source.js';
import { fakeConnector, stubGenerator } from '../../src/testing/fakes.js';

const ARTIFACT: Artifact = {
  version: 2,
  unsatisfiable: null,
  steps: [
    { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts', params: [] },
    { name: 'feedback', source: 'notion', operation: 'feedback.query', args: [{ param: 'sentiment', input: null, value: 'negative' }] },
  ],
  shapeJs: 'function shape(data) { return data.accounts.map((a) => ({ name: a.name, open: data.feedback.filter((f) => f.account === a.name).length })); }',
  assumptions: [],
};
const REQUEST = { intent: 'accounts with their open negative feedback', output: [{ name: 'string', open: 'integer' }] };
const notion = () =>
  fakeApiSource({
    operations: {
      'feedback.query': {
        params: [{ name: 'sentiment', type: 'string', values: ['negative', 'positive'] }],
        columns: [{ name: 'account', type: 'string', nullable: true }],
        rows: [{ account: 'Acme' }],
      },
    },
  });

const instances: Slime[] = [];
after(() => Promise.all(instances.map((slime) => slime.close())));

async function start(options: Record<string, unknown>, store: SlimeStore): Promise<Slime> {
  const config = new SlimeConfig({ sources: { db: fakeConnector({ rows: [{ name: 'Acme' }, { name: 'Globex' }] }), notion: notion() }, store, tiers: { gasToLiquidRuns: 1 }, ...options } as unknown as SlimeOptions);
  const slime = await createSlime(config);
  instances.push(slime);
  return slime;
}

describe('multi-source generation and meta', () => {
  test('a new request runs the steps and shows them in meta and events', async () => {
    const requests: GenerationRequest[] = [];
    const events: SlimeEvent[] = [];
    const generator = stubGenerator((request) => (requests.push(request), ARTIFACT));
    const slime = await start({ generator, onEvent: (event: SlimeEvent) => events.push(event) }, memoryStore());
    const { data, meta } = await slime.query(REQUEST);
    assert.deepEqual(data, [{ name: 'Acme', open: 1 }, { name: 'Globex', open: 0 }]);
    assert.ok(requests[0]?.context.startsWith('Database source "db": '));
    assert.deepEqual(meta.steps?.map(({ name, source, rows, operation }) => ({ name, source, rows, operation })), [
      { name: 'accounts', source: 'db', rows: 2, operation: undefined },
      { name: 'feedback', source: 'notion', rows: 1, operation: 'feedback.query' },
    ]);
    assert.equal(meta.sql, 'SELECT name FROM accounts');
    const generated = events.find((event) => event.type === 'generated');
    assert.deepEqual(generated?.type === 'generated' ? generated.steps : undefined, ARTIFACT.steps);
  });

  test('a saved handler records the prompt hash and per-source hashes (MS17)', async () => {
    const store = memoryStore();
    const slime = await start({ generator: stubGenerator(() => ARTIFACT) }, store);
    const { meta } = await slime.query(REQUEST);
    await slime.flush();
    const saved = (await store.get('handlers', meta.handlerKey)) as { provenance: { promptHash: string; sourceHashes?: Record<string, string> } };
    assert.equal(saved.provenance.promptHash, 'stub-prompt');
    assert.deepEqual(Object.keys(saved.provenance.sourceHashes ?? {}), ['db', 'notion']);
  });

  test('a saved handler is served after a restart, with its steps in meta', async () => {
    const store = memoryStore();
    const first = await start({ generator: stubGenerator(() => ARTIFACT) }, store);
    await first.query(REQUEST);
    await first.flush();
    const generator = stubGenerator(() => ARTIFACT);
    const { data, meta } = await (await start({ generator }, store)).query(REQUEST);
    assert.deepEqual(data, [{ name: 'Acme', open: 1 }, { name: 'Globex', open: 0 }]);
    assert.deepEqual([meta.tier, meta.cache, generator.calls], ['liquid', 'hit', 0]);
    assert.deepEqual(meta.steps?.map(({ name }) => name), ['accounts', 'feedback']);
    assert.equal(meta.sql, 'SELECT name FROM accounts');
  });
});
