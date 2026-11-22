// Local runtime additions: live feed, Lifecycle merge, Crystal's own route,
// and the store helpers Crystallize relies on.
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { memoryStore, type CrystalRegistry, type QueryMeta, type Slime } from '@slime-cloud/core';
import { createApp, mergeHandlers } from '../src/app.js';
import { RecentRequests } from '../src/events.js';
import { storeLimitedTo, syncLiveRuns, toSavedHandler } from '../src/local.js';

const meta = (handlerKey: string, tier: QueryMeta['tier']): QueryMeta =>
  ({ handlerKey, tier, cache: 'hit', timingsMs: { total: 3, run: 2, shape: 0 } }) as unknown as QueryMeta;

function fakeSlime(queries: unknown[] = []): Slime {
  return {
    query: async (request: unknown) => {
      queries.push(request);
      return { data: [{ ok: true }], meta: meta('k1', 'crystal') };
    },
    handlers: () => [{ key: 'k2', intent: 'gas one', tier: 'gas', runs: 2, createdAt: '2026-01-02' }],
    stats: () => ({ mode: 'explore', handlers: { gas: 1, liquid: 0 }, generationsThisHour: 0, generationsInFlight: 0 }),
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

describe('local routes', () => {
  const crystal = { k1: { intent: 'accounts per plan', output: [{ plan: 'string' }], review: 'none', paramTypes: { limit: 'number' } } } as unknown as CrystalRegistry;

  test('a Crystal answers on its own route with its fixed intent and output', async () => {
    const queries: unknown[] = [];
    const events = new RecentRequests();
    const app = createApp({ slime: fakeSlime(queries), connector, crystal, events });
    const res = await app.request('/v0/e/k1', { method: 'POST', body: JSON.stringify({ input: { limit: 5 } }) });
    assert.equal(res.status, 200);
    assert.deepEqual(queries[0], { intent: 'accounts per plan', input: { limit: 5 }, output: [{ plan: 'string' }] });
    assert.equal(events.list().events[0]?.route, 'crystal');
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

  test('local-only routes do not exist unless their parts are given', async () => {
    const app = createApp({ slime: fakeSlime(), connector, crystal: false });
    assert.equal((await app.request('/v0/events')).status, 404);
    assert.equal((await app.request('/v0/lifecycle')).status, 404);
    assert.equal((await app.request('/v0/crystallize', { method: 'POST', body: '{}' })).status, 404);
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
    await app.request('/v0/crystallize', { method: 'POST', body: JSON.stringify({ keys: ['k1', 7] }) });
    assert.deepEqual(gotKeys, ['k1']);
  });
});

describe('store helpers', () => {
  test('storeLimitedTo lists only the chosen handlers', async () => {
    const store = memoryStore();
    await store.put('handlers', 'a', { key: 'a' });
    await store.put('handlers', 'b', { key: 'b' });
    const keys = (await storeLimitedTo(store, ['b']).list('handlers')).map((e) => e.key);
    assert.deepEqual(keys, ['b']);
  });

  test('storeLimitedTo refuses writes: it is a read-only view', () => {
    const view = storeLimitedTo(memoryStore(), ['b']);
    assert.throws(() => view.put('handlers', 'a', { key: 'a' }), /read-only/);
    assert.throws(() => view.delete('handlers', 'a'), /read-only/);
  });

  test('syncLiveRuns raises saved runs to the live count and never lowers them', async () => {
    const store = memoryStore();
    await store.put('handlers', 'a', { key: 'a', runs: 3 });
    await store.put('handlers', 'b', { key: 'b', runs: 9 });
    await syncLiveRuns(store, [{ key: 'a', runs: 11 }, { key: 'b', runs: 4 }, { key: 'gas-only', runs: 2 }]);
    assert.equal(((await store.get('handlers', 'a')) as { runs: number }).runs, 11);
    assert.equal(((await store.get('handlers', 'b')) as { runs: number }).runs, 9);
    assert.equal(await store.get('handlers', 'gas-only'), undefined);
  });

  test('saveRunsOnExit saves live runs even when the flush hangs or fails', async () => {
    const { saveRunsOnExit } = await import('../src/live-runs.js');
    const handlers = () => [{ key: 'a', intent: 'i', tier: 'liquid' as const, runs: 12, createdAt: '1' }];
    for (const flush of [() => new Promise<void>(() => {}), () => Promise.reject(new Error('review store down'))]) {
      const store = memoryStore();
      await store.put('handlers', 'a', { key: 'a', runs: 3 });
      await saveRunsOnExit({ flush, handlers } as never, store, 20);
      assert.equal(((await store.get('handlers', 'a')) as { runs: number }).runs, 12);
    }
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
});
