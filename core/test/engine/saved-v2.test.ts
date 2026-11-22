// A saved handler with API steps is checked against today's sources when it is loaded (MS14).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SlimeConfig, type SlimeOptions } from '../../src/config/slime-config.js';
import { createSlime } from '../../src/create-slime.js';
import type { Slime } from '../../src/engine/types.js';
import type { Artifact } from '../../src/artifact/artifact.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import type { SlimeStore } from '../../src/stores/types.js';
import type { ParamInfo } from '../../src/sources/api/types.js';
import type { Source } from '../../src/sources/types.js';
import { fakeApiSource } from '../../src/testing/fake-api-source.js';
import { artifact, fakeConnector, stubGenerator } from '../../src/testing/fakes.js';

const V2: Artifact = {
  version: 2,
  unsatisfiable: null,
  steps: [
    { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts', params: [] },
    { name: 'feedback', source: 'notion', operation: 'feedback.query', args: [{ param: 'sentiment', input: null, value: 'negative' }] },
  ],
  shapeJs: 'function shape(data) { return data.accounts.map((a) => ({ name: a.name })); }',
  assumptions: [],
};
const REQUEST = { intent: 'accounts with negative feedback', output: [{ name: 'string' }] };
const SENTIMENT: ParamInfo = { name: 'sentiment', type: 'string', values: ['negative', 'positive'] };
const notion = (params: ParamInfo[] = [SENTIMENT]) =>
  fakeApiSource({ operations: { 'feedback.query': { params, columns: [{ name: 'account', type: 'string', nullable: true }], rows: [] } } });

const instances: Slime[] = [];
after(() => Promise.all(instances.map((slime) => slime.close())));

async function start(sources: Record<string, Source>, store: SlimeStore, options: Record<string, unknown> = {}): Promise<Slime> {
  const config = new SlimeConfig({ sources, store, tiers: { gasToLiquidRuns: 1 }, ...options } as unknown as SlimeOptions);
  const slime = await createSlime(config);
  instances.push(slime);
  return slime;
}

describe('saved handlers against changed sources (MS14)', () => {
  const store = memoryStore();
  before(async () => {
    const first = await start({ db: fakeConnector({ rows: [{ name: 'Acme' }] }), notion: notion() }, store, { generator: stubGenerator(() => V2) });
    await first.query(REQUEST);
    await first.flush();
  });

  test('it is served while the sources match', async () => {
    const generator = stubGenerator(() => V2);
    const slime = await start({ db: fakeConnector({ rows: [{ name: 'Acme' }] }), notion: notion() }, store, { generator });
    assert.deepEqual((await slime.query(REQUEST)).data, [{ name: 'Acme' }]);
    assert.equal(generator.calls, 0);
  });

  test('it is generated again when its source is gone', async () => {
    const generator = stubGenerator(() => artifact('SELECT name FROM accounts'));
    const slime = await start({ db: fakeConnector({ rows: [{ name: 'Globex' }] }) }, store, { generator });
    const { data, meta } = await slime.query(REQUEST);
    assert.deepEqual(data, [{ name: 'Globex' }]);
    assert.equal(meta.cache, 'miss');
    assert.equal(generator.calls, 1);
  });

  test('it is generated again when the param it binds was renamed', async () => {
    const generator = stubGenerator(() => artifact('SELECT name FROM accounts'));
    const slime = await start({ db: fakeConnector({ rows: [{ name: 'Acme' }] }), notion: notion([{ ...SENTIMENT, name: 'mood' }]) }, store, { generator });
    assert.equal((await slime.query(REQUEST)).meta.cache, 'miss');
    assert.equal(generator.calls, 1);
  });
});
