// The engine over the real Notion adapter and replayed responses (P6.4): what
// happens when the Notion schema changes, a property is renamed, or Notion is down.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { SlimeConfig } from '../../src/config/slime-config.js';
import { createSlime } from '../../src/create-slime.js';
import type { Slime } from '../../src/engine/types.js';
import type { Artifact } from '../../src/artifact/artifact.js';
import type { FetchFunction } from '../../src/sources/api/http/retry.js';
import { notionSource } from '../../src/sources/api/notion/notion-source.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import type { SlimeStore } from '../../src/stores/types.js';
import { fixtureFetch } from '../../src/testing/fixture-fetch.js';
import { fakeConnector, stubGenerator, type StubGenerator } from '../../src/testing/fakes.js';

const DATA_SOURCE = '1f2e3d4c-5b6a-4789-8abc-def012345678';
const FIXTURES = new URL('../fixtures/notion-handwritten/', import.meta.url);
const replay = fixtureFetch(FIXTURES);
const SCHEMA = JSON.parse(readFileSync(new URL('retrieve-feedback.json', FIXTURES), 'utf8')).response.body;
const HANDLER: Artifact = {
  version: 2,
  unsatisfiable: null,
  steps: [
    { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts', params: [] },
    { name: 'feedback', source: 'notion', operation: 'feedback.query', args: [{ param: 'sentiment', input: null, value: 'negative' }] },
  ],
  shapeJs: 'function shape(data) { return data.accounts.map((a) => ({ name: a.name, negative: data.feedback.filter((f) => f.account === a.name).length })); }',
  assumptions: [],
};
const REQUEST = { intent: 'accounts with negative feedback counts', output: [{ name: 'string', negative: 'integer' }] };

/** Replays the fixtures, but serves `schema` for the data source and `queryStatus` for queries when given. */
function notionFetch({ schema = SCHEMA, queryStatus }: { schema?: unknown; queryStatus?: number } = {}): FetchFunction {
  return (async (input: string, init?: RequestInit) => {
    if (init?.method !== 'POST' && String(input).endsWith(`/v1/data_sources/${DATA_SOURCE}`)) return new Response(JSON.stringify(schema));
    if (init?.method === 'POST' && queryStatus) return new Response('{}', { status: queryStatus });
    return replay(input, init);
  }) as FetchFunction;
}

const instances: Slime[] = [];
after(() => Promise.all(instances.map((slime) => slime.close())));

async function start(store: SlimeStore, fetchImpl: FetchFunction, generator: StubGenerator): Promise<Slime> {
  const notion = notionSource({ token: 'ntn_secret', dataSources: { feedback: DATA_SOURCE }, fetchImpl });
  const slime = await createSlime(new SlimeConfig({ sources: { db: fakeConnector({ rows: [{ name: 'Acme' }] }), notion }, store, tiers: { gasToLiquidRuns: 1 }, generator }));
  instances.push(slime);
  return slime;
}

async function savedStore(generator: StubGenerator): Promise<SlimeStore> {
  const store = memoryStore();
  const slime = await start(store, notionFetch(), generator);
  assert.deepEqual((await slime.query(REQUEST)).data, [{ name: 'Acme', negative: 2 }]);
  await slime.flush();
  return store;
}

describe('the engine over the Notion adapter', () => {
  test('a new Notion property changes the schema hash, so the handler is generated again', async () => {
    const generator = stubGenerator(() => HANDLER);
    const store = await savedStore(generator);
    const withProperty = { ...SCHEMA, properties: { ...SCHEMA.properties, Priority: { name: 'Priority', type: 'select', select: { options: [{ name: 'High' }] } } } };
    const { meta } = await (await start(store, notionFetch({ schema: withProperty }), generator)).query(REQUEST);
    assert.equal(meta.cache, 'miss');
    assert.equal(generator.calls, 2);
  });

  test('a renamed property means the saved handler is not served: it is generated again (MS14)', async () => {
    const generator = stubGenerator(() => HANDLER);
    const store = await savedStore(generator);
    const { Sentiment, ...rest } = SCHEMA.properties;
    const renamed = { ...SCHEMA, properties: { ...rest, Mood: { ...Sentiment, name: 'Mood' } } };
    const slime = await start(store, notionFetch({ schema: renamed }), generator);
    // The stub writes the old handler again, which lint now refuses.
    await assert.rejects(slime.query(REQUEST), { code: 'INVALID_HANDLER', message: /"feedback.query" has no such param/ });
    assert.ok(generator.calls > 1);
  });

  test('Notion answering 503 gives a retryable SOURCE_ERROR and no data', async () => {
    const generator = stubGenerator(() => HANDLER);
    const store = await savedStore(generator);
    const slime = await start(store, notionFetch({ queryStatus: 503 }), generator);
    await assert.rejects(slime.query(REQUEST), { code: 'SOURCE_ERROR', retryable: true, details: { source: 'notion', operation: 'feedback.query', status: 503, attempts: 1 } });
  });
});
