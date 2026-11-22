// What the Lifecycle tab shows for a handler and for the stage rail.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Endpoint } from '../lib/endpoints';
import { readLifecycle, stagesOf, toRow, type RuntimeHandler } from '../lib/lifecycle';
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

describe('readLifecycle', () => {
  test('while the endpoint restarts, the last answer stands in for the unreachable runtime', async () => {
    process.env.SESSION_SECRET = 'x'.repeat(32);
    process.env.SLIME_SECRETS = 'file';
    process.env.SLIME_SECRETS_FILE = join(mkdtempSync(join(tmpdir(), 'slime-lc-')), 'secrets.json');
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
    await new Promise((done) => server.close(done));

    const restarting = await readLifecycle(ep('updating'));
    assert.deepEqual(restarting, live, 'the tab keeps its rows instead of collapsing to a notice');
    const down = await readLifecycle(ep('ready'));
    assert.equal(down.ok, false, 'outside a restart an unreachable runtime is reported');
  });
});
