// What the Lifecycle tab shows for a handler and for the stage rail.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Endpoint } from '../lib/endpoints';
import {
  REQUESTS_PAGE_SIZE,
  readHandlerCode,
  readLifecycle,
  readRequests,
  stagesOf,
  tierStats,
  toRow,
  transitionsOf,
  type LifecycleData,
  type RuntimeEvent,
  type RuntimeHandler,
} from '../lib/lifecycle';
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
    assert.equal(row.stale, true);
    assert.equal(toRow(h({ tier: 'liquid', runs: 12 }), t).stale, false);
    assert.equal(row.progressLabel, 'stale · regenerates on next request');
    assert.equal(row.progressPct, 0);
    const stages = stagesOf('ready', [h({ tier: 'liquid', runs: 12, stale: true })], 12);
    assert.deepEqual(stages.map((s) => s.state), ['done', 'done', 'now', 'todo']);
    // It still sits in the Liquid tier: the stage counts it, the transition does not.
    assert.equal(stages[2]!.count, 1);
  });

  test('a compact progress mark for icon-led lists', () => {
    assert.equal(toRow(h({ runs: 5 }), t).progressShort, '3/3');
    assert.equal(toRow(h({ runs: 1 }), t).progressShort, '1/3');
    assert.equal(toRow(h({ tier: 'liquid', runs: 7 }), t).progressShort, '7/10');
    assert.equal(toRow(h({ tier: 'liquid', runs: 10 }), t).progressShort, 'ready');
    assert.equal(toRow(h({ tier: 'liquid', runs: 12, stale: true }), t).progressShort, 'stale');
    assert.equal(toRow(h({ tier: 'crystal', runs: 12 }), t).progressShort, 'live');
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
    // The Gas badge counts Gas handlers; the note says the agent is linked, not a second, different count.
    assert.equal(all[1]!.note, 'agent linked · 12 requests');
  });

  test('the diagram is the handler lifecycle: Connected, then Gas, Liquid, Crystal', () => {
    const stages = stagesOf('ready', [], 0, t);
    assert.deepEqual(stages.map((s) => s.id), ['connected', 'gas', 'liquid', 'crystal']);
    assert.deepEqual(stages.map((s) => s.label), ['Connected', 'Gas', 'Liquid', 'Crystal']);
    assert.equal(stages[1]!.note, 'waiting for the first request');
    assert.equal(stages[2]!.note, 'after 3 runs');
  });

  test('each tier stage counts the handlers in that tier now', () => {
    const handlers = [h({ key: 'a' }), h({ key: 'b' }), h({ key: 'c', tier: 'liquid', runs: 5 }), h({ key: 'd', tier: 'crystal', runs: 12 })];
    const stages = stagesOf('ready', handlers, 20, t);
    assert.deepEqual(stages.map((s) => s.count), [undefined, 2, 1, 1]);
    // Notes describe the stage; the badge alone carries the count, so the two never disagree.
    assert.deepEqual(stages.map((s) => s.note), ['read-only', 'agent linked · 20 requests', 'saved · survives restarts', 'own route and token']);
  });
});

describe('transitionsOf', () => {
  test('names the trigger, who moves it, and the handlers on the way', () => {
    const handlers = [
      h({ key: 'a', runs: 1 }),
      h({ key: 'b', runs: 3, review: 'pending' }),
      h({ key: 'c', tier: 'liquid', runs: 4 }),
      h({ key: 'd', tier: 'liquid', runs: 11 }),
      h({ key: 'e', tier: 'liquid', runs: 12, stale: true }),
    ];
    const [toGas, toLiquid, toCrystal] = transitionsOf(handlers, 9, t);
    assert.deepEqual(
      [toGas!.id, toLiquid!.id, toCrystal!.id],
      ['connected-gas', 'gas-liquid', 'liquid-crystal'],
    );
    assert.equal(toGas!.actor, 'agent');
    assert.equal(toLiquid!.actor, 'automatic');
    assert.equal(toCrystal!.actor, 'operator');
    assert.match(toLiquid!.rule, /3 successful runs/);
    assert.match(toCrystal!.rule, /10 runs/);
    assert.deepEqual([toGas!.short, toLiquid!.short, toCrystal!.short], ['first request', '3 runs + review', '10 runs + Crystallize']);
    assert.deepEqual([toGas!.runs, toLiquid!.runs, toCrystal!.runs], [undefined, 3, 10]);
    // Gas: both are counting; one reached the run threshold and waits for the review.
    assert.deepEqual([toLiquid!.onTheWay, toLiquid!.ready], [2, 1]);
    // Liquid: the stale row is neither on the way nor pickable.
    assert.deepEqual([toCrystal!.onTheWay, toCrystal!.ready], [2, 1]);
    assert.equal(toGas!.done, true);
  });

  test('before the first request nothing has crossed', () => {
    const [toGas, toLiquid, toCrystal] = transitionsOf([], 0, t);
    assert.equal(toGas!.done, false);
    assert.equal(toLiquid!.done, false);
    assert.equal(toCrystal!.done, false);
  });
});

describe('tierStats', () => {
  const e = (tier: RuntimeEvent['tier'], ms: number): RuntimeEvent => ({ at: '2026-11-22T10:00:00Z', handlerKey: 'abc', tier, cache: 'hit', ms });

  test('counts and averages the recent requests answered by a tier', () => {
    const events = [e('gas', 4), e('gas', 2), e('liquid', 3), e('crystal', 1.5)];
    assert.deepEqual(tierStats(events, 'gas'), { requests: 2, avgMs: 3 });
    assert.deepEqual(tierStats(events, 'crystal'), { requests: 1, avgMs: 1.5 });
  });

  test('a tier with no recent requests has no average', () => {
    assert.deepEqual(tierStats([], 'liquid'), { requests: 0, avgMs: null });
  });
});

describe('readLifecycle without a running endpoint', () => {
  const base = { endpointId: 'ep-0a1b2c3d4e', owner: 'a@b.c', name: 'n', provider: 'claude', connectorType: 'postgres', tokenHint: 'abcd', createdAt: '', updatedAt: '' } as const;

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

describe('readHandlerCode (the trace drawer)', () => {
  test('asks the runtime by key, never for a malformed one, and reports a miss as null', async () => {
    process.env.SESSION_SECRET = 'x'.repeat(32);
    process.env.SLIME_SECRETS = 'file';
    process.env.SLIME_SECRETS_FILE = join(mkdtempSync(join(tmpdir(), 'slime-hc-')), 'secrets.json');
    delete process.env.SLIME_RUNTIME_URL;
    await secretStore().put('ep-code', 'SLIME_API_KEY', 'slm_test');
    const asked: string[] = [];
    const code = { key: 'a3f9c1e07d', tier: 'liquid', sql: 'select 1', assumptions: [] };
    const server = createServer((req, res) => {
      asked.push(req.url ?? '');
      if (req.url === '/v0/handlers/a3f9c1e07d/code') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(code));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const ep = { endpointId: 'ep-code', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, status: 'ready' } as Endpoint;
      assert.deepEqual(await readHandlerCode(ep, 'a3f9c1e07d'), code);
      assert.equal(await readHandlerCode(ep, 'missing-key'), null);
      // A key with a slash or a parent-dir segment never reaches fetch: it fails the key shape first.
      assert.equal(await readHandlerCode(ep, '../secrets'), null);
      assert.equal(await readHandlerCode(ep, 'a/b'), null);
      assert.deepEqual(asked, ['/v0/handlers/a3f9c1e07d/code', '/v0/handlers/missing-key/code']);
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });

  test('an endpoint that is not running never answers', async () => {
    const ep = { endpointId: 'ep-down', status: 'pending' } as Endpoint;
    assert.equal(await readHandlerCode(ep, 'a3f9c1e07d'), null);
  });
});
