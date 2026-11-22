// What the Lifecycle tab shows for a handler and for the stage rail.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Endpoint } from '../lib/endpoints';
import { REQUESTS_PAGE_SIZE, readLifecycle, readRequests, stagesOf, toRow, type LifecycleData, type RuntimeHandler } from '../lib/lifecycle';
import { secretStore } from '../lib/secrets';

const t = { liquidRuns: 3, crystalRuns: 10 };
const h = (over: Partial<RuntimeHandler>): RuntimeHandler => ({ key: 'abcdef123456', intent: 'accounts per plan', tier: 'gas', runs: 1, ...over });

describe('toRow', () => {
  test('Gas counts towards Liquid; its review label is the engine status, not a guess from runs', () => {
    const fresh = toRow(h({ runs: 1 }), t);
    assert.equal(fresh.progressLabel, '1/3 to Liquid');
    assert.equal(fresh.review.label, '—');
    assert.equal(fresh.shortKey, 'abcdef');
    const due = toRow(h({ runs: 3 }), t);
    assert.equal(due.progressPct, 100);
    assert.equal(due.review.label, '—');
    assert.equal(due.canCrystallize, false);
    assert.equal(toRow(h({ runs: 3, review: 'pending' }), t).review.label, 'reviewing…');
  });

  test('Liquid counts towards Crystal and becomes pickable at the threshold', () => {
    const young = toRow(h({ tier: 'liquid', runs: 7, review: 'approved' }), t);
    assert.equal(young.progressLabel, '7/10 to Crystal');
    assert.equal(young.canCrystallize, false);
    const proven = toRow(h({ tier: 'liquid', runs: 10, review: 'none' }), t);
    assert.equal(proven.progressLabel, 'ready to crystallize');
    assert.equal(proven.canCrystallize, true);
    assert.equal(proven.review.label, 'no reviewer');
  });

  test('a stale saved Liquid handler is never pickable and says it regenerates', () => {
    const row = toRow(h({ tier: 'liquid', runs: 12, review: 'approved', stale: true }), t);
    assert.equal(row.canCrystallize, false);
    assert.equal(row.progressLabel, 'stale · regenerates on next request');
    assert.equal(row.progressPct, 0);
    const stages = stagesOf('ready', [h({ tier: 'liquid', runs: 12, stale: true })], 12);
    assert.deepEqual(stages.map((s) => s.state), ['done', 'done', 'now', 'todo']);
  });

  test('a Crystal is its own endpoint and is never picked again', () => {
    const row = toRow(h({ tier: 'crystal', runs: 12, inputs: { limit: 'number', country: null } }), t);
    assert.equal(row.exampleBody, '{"input":{"limit":5,"country":null}}');
    assert.equal(row.progressLabel, 'own endpoint');
    assert.equal(row.canCrystallize, false);
  });
});

describe('stagesOf', () => {
  const states = (s: ReturnType<typeof stagesOf>) => s.map((x) => x.state);

  test('a pending endpoint has only the first stage in progress', () => {
    assert.deepEqual(states(stagesOf('pending', [], 0)), ['now', 'todo', 'todo', 'todo']);
  });

  test('ready with no requests waits for the agent', () => {
    assert.deepEqual(states(stagesOf('ready', [], 0)), ['done', 'now', 'todo', 'todo']);
  });

  test('stages light up as handlers mature', () => {
    assert.deepEqual(states(stagesOf('ready', [h({})], 1)), ['done', 'done', 'now', 'todo']);
    assert.deepEqual(states(stagesOf('ready', [h({ tier: 'liquid', runs: 4 })], 4)), ['done', 'done', 'done', 'now']);
    const all = stagesOf('ready', [h({ tier: 'crystal', runs: 12 })], 12);
    assert.deepEqual(states(all), ['done', 'done', 'done', 'done']);
    assert.equal(all[1]!.note, '1 handler · 12 requests');
  });
});

describe('readLifecycle without a running endpoint', () => {
  const base = { endpointId: 'ep-0a1b2c3d4e', owner: 'a@b.c', name: 'n', provider: 'groq', connectorType: 'postgres', tokenHint: 'abcd', createdAt: '', updatedAt: '' } as const;

  test('a failed endpoint shows why it failed', async () => {
    const data = await readLifecycle({ ...base, status: 'failed', error: 'Health check failed: connect ECONNREFUSED 127.0.0.1:1' } as Endpoint);
    assert.deepEqual(data, { ok: false, reason: 'Endpoint failed: Health check failed: connect ECONNREFUSED 127.0.0.1:1' });
  });

  test('a failed endpoint without a recorded error still says it failed', async () => {
    assert.deepEqual(await readLifecycle({ ...base, status: 'failed' } as Endpoint), { ok: false, reason: 'Endpoint failed.' });
  });
});

describe('readLifecycle across a local restart', () => {
  test('while the endpoint restarts, the last answer stands in for the unreachable runtime', async () => {
    process.env.SESSION_SECRET = 'x'.repeat(32);
    process.env.SLIME_SECRETS = 'file';
    process.env.SLIME_SECRETS_FILE = join(mkdtempSync(join(tmpdir(), 'slime-lc-')), 'secrets.json');
    delete process.env.SLIME_RUNTIME_URL;
    await secretStore().put('ep-restart', 'SLIME_API_KEY', 'slm_test');
    const handler = h({ tier: 'liquid', runs: 12 });
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/v0/events' ? { total: 12, events: [] } : { handlers: [handler], thresholds: t, warnings: [] }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const ep = (status: string) => ({ endpointId: 'ep-restart', url, status }) as Endpoint;

    const live = await readLifecycle(ep('ready'));
    assert.equal(live.ok, true);
    // Drop the pooled keep-alive socket too, so the next reads get a refused connection like a restart.
    server.closeAllConnections();
    await new Promise((done) => server.close(done));

    assert.deepEqual(await readLifecycle(ep('updating')), live, 'the tab keeps its rows instead of collapsing to a notice');
    // A ready endpoint under load misses the occasional poll (busy serving the request we polled
    // about); the board stands for a few polls so it does not flicker away on every request.
    assert.deepEqual(await readLifecycle(ep('ready')), live, 'a single missed poll keeps the board');
    // But a runtime that stays unreachable eventually collapses to the notice.
    let down: LifecycleData = live;
    for (let i = 0; i < 5; i++) down = await readLifecycle(ep('ready'));
    assert.equal(down.ok, false, 'a persistently unreachable runtime is reported');
  });
});

describe('readRequests (the Requests log pages)', () => {
  test('asks the runtime for one page by cursor and passes the page flags through; a malformed cursor reads the first page', async () => {
    process.env.SESSION_SECRET = 'x'.repeat(32);
    process.env.SLIME_SECRETS = 'file';
    process.env.SLIME_SECRETS_FILE = join(mkdtempSync(join(tmpdir(), 'slime-rq-')), 'secrets.json');
    delete process.env.SLIME_RUNTIME_URL;
    await secretStore().put('ep-pages', 'SLIME_API_KEY', 'slm_test');
    const asked: string[] = [];
    const event = { id: '2026-11-22T12:00:00.000Z-000001-abc123', at: '2026-11-22T12:00:00.000Z', handlerKey: 'k', tier: 'gas', cache: 'hit', ms: 3 };
    const server = createServer((req, res) => {
      asked.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ total: 80, events: [event], hasOlder: true, hasNewer: true }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const ep = { endpointId: 'ep-pages', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, status: 'ready' } as Endpoint;
      const page = await readRequests(ep, { before: event.id });
      assert.deepEqual(page, { ok: true, total: 80, events: [event], hasOlder: true, hasNewer: true });
      await readRequests(ep, { after: event.id });
      await readRequests(ep, { before: '{"$ne":1}' });
      await readRequests(ep, {});
      assert.deepEqual(asked, [
        `/v0/events?limit=${REQUESTS_PAGE_SIZE}&before=${encodeURIComponent(event.id)}`,
        `/v0/events?limit=${REQUESTS_PAGE_SIZE}&after=${encodeURIComponent(event.id)}`,
        `/v0/events?limit=${REQUESTS_PAGE_SIZE}`,
        `/v0/events?limit=${REQUESTS_PAGE_SIZE}`,
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });
});
