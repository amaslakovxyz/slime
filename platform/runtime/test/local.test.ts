// The endpoint's routes and parts: live feed, Lifecycle merge, Crystal's own route,
// and the store helpers Crystallize relies on.
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { memoryStore, type CrystalRegistry, type QueryMeta, type Slime } from '@slime-cloud/core';
import { createApp, mergeHandlers } from '../src/app.js';
import { RecentRequests, StoredRequests, type RequestFeed } from '../src/events.js';
import { DynamoSlimeStore } from '../src/store-dynamodb.js';
import { FakeDynamo } from './fake-dynamo.js';
import { toSavedHandler } from '../src/endpoint-runtime.js';
import { LiveRunsSync, syncLiveRuns } from '../src/live-runs.js';

const meta = (handlerKey: string, tier: QueryMeta['tier']): QueryMeta =>
  ({ handlerKey, tier, cache: 'hit', timingsMs: { total: 3, run: 2, shape: 0 } }) as unknown as QueryMeta;

function fakeSlime(queries: unknown[] = []): Slime {
  return {
    query: async (request: unknown) => {
      queries.push(request);
      return { data: [{ ok: true }], meta: meta('k1', 'crystal') };
    },
    handlers: () => [{ key: 'k2', intent: 'gas one', tier: 'gas', runs: 2, createdAt: '2026-01-02' }],
    stats: () => ({ handlers: { gas: 1, liquid: 0 }, generationsThisHour: 0, generationsInFlight: 0 }),
  } as unknown as Slime;
}

const connector = { safetyCheck: async () => ({ ok: true }) } as never;

describe('RecentRequests', () => {
  test('keeps the newest first and drops the oldest past the cap', () => {
    const events = new RecentRequests(2);
    events.record(meta('a', 'gas'));
    events.record(meta('b', 'liquid'));
    events.record(meta('c', 'crystal'), 'crystal');
    const { total, events: list } = events.list();
    assert.equal(total, 3);
    assert.deepEqual(list.map((e) => e.handlerKey), ['c', 'b']);
    assert.equal(list[0]?.route, 'crystal');
  });
});

describe('StoredRequests (the feed shared by every instance of an endpoint)', () => {
  test('two instances over one store show the same log: what one answered, the other lists', async () => {
    const store = memoryStore();
    const a = new StoredRequests({ store });
    const b = new StoredRequests({ store });
    a.record(meta('a', 'gas'));
    await a.flush();
    // Two instances' events in one millisecond have no defined order; these are a few ms apart.
    await new Promise((done) => setTimeout(done, 5));
    b.record(meta('b', 'liquid'), 'crystal');
    await b.flush();
    const [fromA, fromB] = [await a.list(), await b.list()];
    assert.deepEqual(fromA, fromB);
    assert.deepEqual(fromA.events.map((e) => e.handlerKey), ['b', 'a'], 'newest first');
    assert.equal(fromA.events[0]?.route, 'crystal');
    assert.equal(fromA.total, 2, 'without a usage total, the stored events are counted');
    assert.deepEqual(await new StoredRequests({ store }).list(), fromA, 'a fresh (cold) instance is not empty');
  });

  test('the total is the endpoint-wide usage count when there is one', async () => {
    const store = memoryStore();
    const feed = new StoredRequests({ store, total: async () => 1234 });
    feed.record(meta('a', 'gas'));
    await feed.flush();
    assert.equal((await feed.list()).total, 1234);
    const unknown = new StoredRequests({ store, total: async () => undefined });
    assert.equal((await unknown.list()).total, 1, 'an unreadable usage total falls back to the stored count');
  });

  test('lists at most the cap and prunes the oldest from the store', async () => {
    const store = memoryStore();
    const feed = new StoredRequests({ store, cap: 3, pruneEvery: 2 });
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
      feed.record(meta(key, 'gas'));
      await feed.flush();
    }
    assert.deepEqual((await feed.list()).events.map((e) => e.handlerKey), ['f', 'e', 'd']);
    assert.ok((await store.list('events')).length <= 3 + 2, 'the store keeps the cap plus at most one prune interval');
  });

  test('a store that fails never fails the request: record and flush swallow, list falls back to nothing', async () => {
    const broken = { get: async () => undefined, put: async () => { throw new Error('throttled'); }, list: async () => { throw new Error('down'); }, delete: async () => {} } as never;
    const errors: string[] = [];
    const feed = new StoredRequests({ store: broken, log: (line) => errors.push(JSON.stringify(line)) });
    feed.record(meta('a', 'gas'));
    await feed.flush();
    assert.deepEqual(await feed.list(), { total: 0, events: [], hasOlder: false, hasNewer: false });
    assert.equal(errors.length, 2);
  });
});

// The same paging contract for every feed: in memory, over any store (list + sort), and on DynamoDB (one Query).
const feeds: [string, () => RequestFeed & { flush?: () => Promise<void> }][] = [
  ['RecentRequests', () => new RecentRequests(500)],
  ['StoredRequests on a memory store', () => new StoredRequests({ store: memoryStore(), cap: 500 })],
  ['StoredRequests on DynamoDB', () => new StoredRequests({ store: new DynamoSlimeStore({ table: 't', tenantId: 'ep-a', client: new FakeDynamo(4) }), cap: 500 })],
];
for (const [name, make] of feeds) {
  describe(`${name}: pages`, () => {
    async function filled(count: number) {
      const feed = make();
      for (let i = 0; i < count; i++) feed.record(meta(`k${String(i).padStart(2, '0')}`, 'gas'));
      await feed.flush?.();
      return feed;
    }
    const keys = (list: { events: { handlerKey: string }[] }) => list.events.map((e) => e.handlerKey);

    test('the first page is the newest, with an id per event and only older ones beyond it', async () => {
      const feed = await filled(12);
      const first = await feed.list({ limit: 5 });
      assert.deepEqual(keys(first), ['k11', 'k10', 'k09', 'k08', 'k07']);
      assert.deepEqual([first.hasNewer, first.hasOlder, first.total], [false, true, 12]);
      assert.ok(first.events.every((e) => typeof e.id === 'string' && e.id.length > 0));
    });

    test('before walks to older pages and after walks back, without gaps or repeats', async () => {
      const feed = await filled(12);
      const first = await feed.list({ limit: 5 });
      const second = await feed.list({ limit: 5, before: first.events.at(-1)!.id });
      assert.deepEqual(keys(second), ['k06', 'k05', 'k04', 'k03', 'k02']);
      assert.deepEqual([second.hasNewer, second.hasOlder], [true, true]);
      const last = await feed.list({ limit: 5, before: second.events.at(-1)!.id });
      assert.deepEqual(keys(last), ['k01', 'k00']);
      assert.deepEqual([last.hasNewer, last.hasOlder], [true, false]);
      const back = await feed.list({ limit: 5, after: last.events[0]!.id });
      assert.deepEqual(keys(back), keys(second), 'after returns the page just newer, newest first');
      assert.deepEqual([back.hasNewer, back.hasOlder], [true, true]);
      const top = await feed.list({ limit: 5, after: back.events[0]!.id });
      assert.deepEqual(keys(top), keys(first));
      assert.equal(top.hasNewer, false);
    });

    test('without a limit it lists 50, as the Lifecycle board expects', async () => {
      const feed = await filled(60);
      assert.equal((await feed.list()).events.length, 50);
    });
  });
}

describe('StoredRequests retention', () => {
  test('keeps the newest 500 by default', async () => {
    const store = memoryStore();
    const feed = new StoredRequests({ store, pruneEvery: 1 });
    for (let i = 0; i < 510; i++) feed.record(meta(`k${i}`, 'gas'));
    await feed.flush();
    assert.equal((await store.list('events')).length, 500);
  });
});

describe('mergeHandlers', () => {
  test('one row per key, the most mature tier wins, runs never go backwards', () => {
    const merged = mergeHandlers([
      [{ key: 'x', intent: 'i', tier: 'liquid', runs: 3, review: 'none', createdAt: '1' }],
      [{ key: 'x', intent: 'i', tier: 'liquid', runs: 7 }],
      [{ key: 'x', intent: 'i', tier: 'crystal', runs: 0, review: 'none' }],
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.tier, 'crystal');
    assert.equal(merged[0]?.runs, 7);
    assert.equal(merged[0]?.createdAt, '1');
  });

  test('a stale saved row loses to a live row: regenerated Gas keeps its own runs, a Crystal keeps the history', () => {
    const merged = mergeHandlers([
      [{ key: 'x', intent: 'i', tier: 'liquid', runs: 9, review: 'approved', fixtures: 5, stale: true, createdAt: '1' }],
      [{ key: 'x', intent: 'i', tier: 'gas', runs: 1, createdAt: '2' }],
    ]);
    assert.equal(merged.length, 1);
    // Nothing of the stale record leaks into the regenerated row.
    assert.deepEqual(merged[0], { key: 'x', intent: 'i', tier: 'gas', runs: 1, createdAt: '2' });
    const crystal = mergeHandlers([
      [{ key: 'x', intent: 'i', tier: 'liquid', runs: 13, stale: true }],
      [{ key: 'x', intent: 'i', tier: 'crystal', runs: 0 }],
    ]);
    assert.deepEqual([crystal[0]?.tier, crystal[0]?.runs, 'stale' in crystal[0]!], ['crystal', 13, false]);
  });
});

describe('endpoint routes', () => {
  const crystal = { k1: { intent: 'accounts per plan', output: [{ plan: 'string' }], review: 'none', paramTypes: { limit: 'number' } } } as unknown as CrystalRegistry;

  test('a Crystal answers on its own route with its fixed intent and output', async () => {
    const queries: unknown[] = [];
    const events = new RecentRequests();
    const app = createApp({ slime: fakeSlime(queries), connector, crystal, events });
    const res = await app.request('/v0/e/k1', { method: 'POST', body: JSON.stringify({ input: { limit: 5 } }) });
    assert.equal(res.status, 200);
    assert.deepEqual(queries[0], { intent: 'accounts per plan', input: { limit: 5 }, output: [{ plan: 'string' }] });
    assert.equal((await events.list()).events[0]?.route, 'crystal');
  });

  test('a Crystal call without one of its inputs is a 400 that names them', async () => {
    const app = createApp({ slime: fakeSlime(), connector, crystal });
    const res = await app.request('/v0/e/k1', { method: 'POST', body: JSON.stringify({ input: {} }) });
    assert.equal(res.status, 400);
    const { error } = (await res.json()) as { error: { message: string } };
    assert.match(error.message, /takes input: limit \(number\)\. Missing: limit\./);
  });

  test('a Crystal call with an unknown input name is a 400 and never reaches the engine', async () => {
    const queries: unknown[] = [];
    const app = createApp({ slime: fakeSlime(queries), connector, crystal });
    // Inherited names (toString, constructor, __proto__) must count as unknown too: any extra name changes the key.
    for (const name of ['extra', 'toString', 'constructor', '__proto__']) {
      const res = await app.request('/v0/e/k1', { method: 'POST', body: `{"input":{"limit":5,"${name}":1}}` });
      assert.equal(res.status, 400, name);
      const { error } = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.match(error.message, new RegExp(`Unknown: ${name}\\.`));
    }
    assert.deepEqual(queries, []);
  });

  test('an unknown Crystal key is 404, including names inherited from Object.prototype', async () => {
    const app = createApp({ slime: fakeSlime(), connector, crystal });
    for (const key of ['nope', 'constructor', '__proto__']) {
      assert.equal((await app.request(`/v0/e/${key}`, { method: 'POST', body: '{}' })).status, 404, key);
    }
  });

  test('the Crystal route has the same 16 KB body limit as /v0/query', async () => {
    const queries: unknown[] = [];
    const app = createApp({ slime: fakeSlime(queries), connector, crystal });
    const body = JSON.stringify({ input: { limit: 5, pad: 'x'.repeat(20_000) } });
    const res = await app.request('/v0/e/k1', { method: 'POST', body, headers: { 'content-length': String(body.length) } });
    assert.equal(res.status, 413);
    assert.deepEqual(queries, []);
  });

  test('GET /v0/events pages with limit, before and after, and refuses bad ones', async () => {
    const events = new RecentRequests();
    for (const key of ['a', 'b', 'c']) events.record(meta(key, 'gas'));
    const app = createApp({ slime: fakeSlime(), connector, crystal: false, events });
    const first = (await (await app.request('/v0/events?limit=2')).json()) as { events: { id: string; handlerKey: string }[]; hasOlder: boolean };
    assert.deepEqual([first.events.map((e) => e.handlerKey), first.hasOlder], [['c', 'b'], true]);
    const older = (await (await app.request(`/v0/events?limit=2&before=${encodeURIComponent(first.events[1]!.id)}`)).json()) as { events: { handlerKey: string }[] };
    assert.deepEqual(older.events.map((e) => e.handlerKey), ['a']);
    for (const query of ['limit=0', 'limit=101', 'limit=x', 'before=a&after=b', 'before=%7B%22%24ne%22%7D', `before=${'x'.repeat(100)}`]) {
      const res = await app.request(`/v0/events?${query}`);
      assert.equal(res.status, 400, query);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'INVALID_REQUEST');
    }
  });

  test('optional routes do not exist unless their parts are given', async () => {
    const app = createApp({ slime: fakeSlime(), connector, crystal: false });
    assert.equal((await app.request('/v0/events')).status, 404);
    assert.equal((await app.request('/v0/lifecycle')).status, 404);
    assert.equal((await app.request('/v0/crystallize', { method: 'POST', body: '{}' })).status, 404);
  });

  test('a path or method the endpoint does not serve is a JSON 404 that points at /v0/query', async () => {
    const app = createApp({ slime: fakeSlime(), connector, crystal: false });
    // `//v0/query` is what a base URL ending in `/` plus `/v0/query` produces.
    for (const [method, path] of [['POST', '//v0/query'], ['GET', '/'], ['GET', '/v0/query'], ['POST', '/v0/nope']] as const) {
      const res = await app.request(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal(res.status, 404, `${method} ${path}`);
      const { error } = (await res.json()) as { error: { code: string; message: string; retryable: boolean } };
      assert.deepEqual([error.code, error.retryable], ['NOT_FOUND', false], `${method} ${path}`);
      assert.ok(error.message.includes(`${method} ${path}`) && error.message.includes('POST /v0/query'), error.message);
    }
  });

  test('lifecycle merges saved, live and Crystal handlers; crystallize passes keys through', async () => {
    let gotKeys: string[] | undefined;
    const app = createApp({
      slime: fakeSlime(),
      connector,
      crystal,
      savedHandlers: async () => [{ key: 'k1', intent: 'accounts per plan', tier: 'liquid', runs: 12, createdAt: '2026-01-01' }],
      warnings: () => ['w1'],
      crystallize: async (keys) => {
        gotKeys = keys;
        return [];
      },
    });
    const body = (await (await app.request('/v0/lifecycle')).json()) as { handlers: { key: string; tier: string; runs: number }[]; warnings: string[] };
    assert.deepEqual(body.handlers.map((h) => [h.key, h.tier, h.runs]), [['k1', 'crystal', 12], ['k2', 'gas', 2]]);
    assert.deepEqual(body.warnings, ['w1']);
    assert.equal('instance' in body, false, 'one process serves the whole endpoint');
    await app.request('/v0/crystallize', { method: 'POST', body: JSON.stringify({ keys: ['k1', 7] }) });
    assert.deepEqual(gotKeys, ['k1']);
  });

  test('lifecycle says instance: true when the feed and Gas rows are one instance of several', async () => {
    const app = createApp({ slime: fakeSlime(), connector, crystal: false, savedHandlers: async () => [], isPerInstance: true });
    const body = (await (await app.request('/v0/lifecycle')).json()) as { instance?: boolean };
    assert.equal(body.instance, true);
  });
});

describe('store helpers', () => {
  test('syncLiveRuns raises saved runs to the live count and never lowers them', async () => {
    const store = memoryStore();
    await store.put('handlers', 'a', { key: 'a', runs: 3 });
    await store.put('handlers', 'b', { key: 'b', runs: 9 });
    await syncLiveRuns(store, [{ key: 'a', runs: 11 }, { key: 'b', runs: 4 }, { key: 'gas-only', runs: 2 }]);
    assert.equal(((await store.get('handlers', 'a')) as { runs: number }).runs, 11);
    assert.equal(((await store.get('handlers', 'b')) as { runs: number }).runs, 9);
    assert.equal(await store.get('handlers', 'gas-only'), undefined);
  });

  test('toSavedHandler marks a record made with another provenance as stale, only when given the current one', () => {
    const provenance = { schemaHash: 'old', dictionaryHash: 'd', promptHash: 'p', model: 'm' };
    const record = { key: 'a', intent: 'i', tier: 'liquid', runs: 12, review: 'approved', fixtures: [{}], createdAt: '1', provenance };
    assert.equal(toSavedHandler(record, { ...provenance, schemaHash: 'new' }).stale, true);
    assert.equal('stale' in toSavedHandler(record, { ...provenance }), false);
    assert.equal('stale' in toSavedHandler(record), false);
  });
});

describe('LiveRunsSync', () => {
  test('syncs Liquid handlers at most once per interval', async () => {
    const { LiveRunsSync } = await import('../src/live-runs.js');
    const store = memoryStore();
    await store.put('handlers', 'liq', { key: 'liq', runs: 3 });
    await store.put('handlers', 'gas', { key: 'gas', runs: 1 });
    let now = 0;
    let live = [{ key: 'liq', tier: 'liquid', runs: 8 }, { key: 'gas', tier: 'gas', runs: 5 }];
    const sync = new LiveRunsSync(store, () => live, 60_000, () => now);
    now = 60_000;
    assert.equal(await sync.maybeSync(), true);
    assert.equal(((await store.get('handlers', 'liq')) as { runs: number }).runs, 8);
    assert.equal(((await store.get('handlers', 'gas')) as { runs: number }).runs, 1);
    live = [{ key: 'liq', tier: 'liquid', runs: 20 }];
    now = 90_000;
    assert.equal(await sync.maybeSync(), false);
    assert.equal(((await store.get('handlers', 'liq')) as { runs: number }).runs, 8);
    now = 120_000;
    assert.equal(await sync.maybeSync(), true);
    assert.equal(((await store.get('handlers', 'liq')) as { runs: number }).runs, 20);
  });

  test('with interval 0 every grown Liquid count is written at once; unchanged counts cost no store call', async () => {
    const store = memoryStore();
    await store.put('handlers', 'liq', { key: 'liq', runs: 3 });
    const savedRuns = async (): Promise<unknown> => {
      const saved = await store.get('handlers', 'liq');
      return saved && typeof saved === 'object' && 'runs' in saved ? saved.runs : undefined;
    };
    let gets = 0;
    const counting: typeof store = { ...store, get: async (ns, key) => (gets++, store.get(ns, key)) };
    let live = [{ key: 'liq', tier: 'liquid', runs: 4 }];
    const sync = new LiveRunsSync(counting, () => live, 0);
    assert.equal(await sync.maybeSync(), true);
    assert.equal(await savedRuns(), 4);
    const before = gets;
    assert.equal(await sync.maybeSync(), false, 'same count: nothing to write');
    assert.equal(gets, before);
    live = [{ key: 'liq', tier: 'liquid', runs: 12 }];
    assert.equal(await sync.maybeSync(), true);
    assert.equal(await savedRuns(), 12);
  });
});
