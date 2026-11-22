// Saved v2 handlers are checked against today's sources on load and at locked startup (MS14).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SlimeConfig, type SlimeOptions } from '../../src/config/slime-config.js';
import type { SlimeEvent } from '../../src/config/events.js';
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

describe('saved v2 handlers against changed sources (MS14)', () => {
  const store = memoryStore();
  before(async () => {
    const explore = await start({ db: fakeConnector({ rows: [{ name: 'Acme' }] }), notion: notion() }, store, { generator: stubGenerator(() => V2) });
    await explore.query(REQUEST);
    await explore.flush();
  });

  test('locked mode still serves it while the sources match', async () => {
    const locked = await start({ db: fakeConnector({ rows: [{ name: 'Acme' }] }), notion: notion() }, store);
    assert.deepEqual((await locked.query(REQUEST)).data, [{ name: 'Acme' }]);
  });

  test('locked mode refuses it with the reason when its source is gone', async () => {
    const locked = await start({ db: fakeConnector() }, store);
    await assert.rejects(locked.query(REQUEST), { code: 'HANDLER_NOT_FOUND', message: /no longer fits the configured sources: .*unknown source "notion"/ });
  });

  test('locked mode refuses it when the param it binds was renamed', async () => {
    const locked = await start({ db: fakeConnector(), notion: notion([{ ...SENTIMENT, name: 'mood' }]) }, store);
    await assert.rejects(locked.query(REQUEST), { code: 'HANDLER_NOT_FOUND', message: /has no such param/ });
  });

  test('explore mode regenerates it instead', async () => {
    const generator = stubGenerator(() => artifact('SELECT name FROM accounts'));
    const explore = await start({ db: fakeConnector({ rows: [{ name: 'Globex' }] }) }, store, { generator });
    const { data, meta } = await explore.query(REQUEST);
    assert.deepEqual(data, [{ name: 'Globex' }]);
    assert.equal(meta.cache, 'miss');
    assert.equal(generator.calls, 1);
  });

  test('locked startup lists the handlers that no longer fit', async () => {
    const otherStore = memoryStore();
    const explore = await start({ db: fakeConnector({ rows: [{ name: 'Acme' }] }), notion: notion() }, otherStore, { generator: stubGenerator(() => V2) });
    await explore.query(REQUEST);
    await explore.flush();
    const warnings: string[] = [];
    await start({ db: fakeConnector() }, otherStore, { onEvent: (event: SlimeEvent) => event.type === 'warning' && warnings.push(event.message) });
    assert.ok(warnings.some((message) => /^1 saved handler\(s\) no longer fit the configured sources and are not served: [0-9a-f]{12}: .*unknown source "notion"/.test(message)), warnings.join('\n'));
  });
});
