// Local runtime additions: live feed, Lifecycle merge, Crystal's own route,
// and the store helpers Crystallize relies on.
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { memoryStore, type CrystalRegistry, type QueryMeta, type Slime } from '@slime-cloud/core';
import { createApp, mergeHandlers } from '../src/app.js';
import { RecentRequests } from '../src/events.js';
import { storeLimitedTo, syncLiveRuns } from '../src/local.js';

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
});

describe('local routes', () => {
  const crystal = { k1: { intent: 'accounts per plan', output: [{ plan: 'string' }], review: 'none' } } as unknown as CrystalRegistry;

  test('a Crystal answers on its own route with its fixed intent and output', async () => {
    const queries: unknown[] = [];
    const events = new RecentRequests();
    const app = createApp({ slime: fakeSlime(queries), connector, crystal, events });
    const res = await app.request('/v0/e/k1', { method: 'POST', body: JSON.stringify({ input: { limit: 5 } }) });
    assert.equal(res.status, 200);
    assert.deepEqual(queries[0], { intent: 'accounts per plan', input: { limit: 5 }, output: [{ plan: 'string' }] });
    assert.equal(events.list().events[0]?.route, 'crystal');
  });

  test('an unknown Crystal key is 404', async () => {
    const app = createApp({ slime: fakeSlime(), connector, crystal });
    assert.equal((await app.request('/v0/e/nope', { method: 'POST', body: '{}' })).status, 404);
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
      crystallize: async (keys) => {
        gotKeys = keys;
        return [];
      },
    });
    const body = (await (await app.request('/v0/lifecycle')).json()) as { handlers: { key: string; tier: string; runs: number }[] };
    assert.deepEqual(body.handlers.map((h) => [h.key, h.tier, h.runs]), [['k1', 'crystal', 12], ['k2', 'gas', 2]]);
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

  test('syncLiveRuns raises saved runs to the live count and never lowers them', async () => {
    const store = memoryStore();
    await store.put('handlers', 'a', { key: 'a', runs: 3 });
    await store.put('handlers', 'b', { key: 'b', runs: 9 });
    await syncLiveRuns(store, [{ key: 'a', runs: 11 }, { key: 'b', runs: 4 }, { key: 'gas-only', runs: 2 }]);
    assert.equal(((await store.get('handlers', 'a')) as { runs: number }).runs, 11);
    assert.equal(((await store.get('handlers', 'b')) as { runs: number }).runs, 9);
    assert.equal(await store.get('handlers', 'gas-only'), undefined);
  });
});
