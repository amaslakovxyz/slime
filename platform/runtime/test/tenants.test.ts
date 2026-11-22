// The Lambda router and tenant cache: routing on the endpoint id, auth per endpoint,
// settings re-read per TTL, LRU eviction, and no endpoint setting in process.env.
// SSM, S3 and DynamoDB are fakes; endpoints run on the demo Postgres, canned handlers for the model.
import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ENDPOINTS_SSM_PREFIX } from '../src/tenants.js';
import { FakeDynamo } from './fake-dynamo.js';
import { harness, isDatabaseAvailable, keyOf, type Harness } from './tenant-harness.js';

const A = 'ep-00000000a1';
const B = 'ep-00000000b2';
const C = 'ep-00000000c3';
const TTL_MS = 30_000;
const COUNT_PER_PLAN = {
  intent: 'number of accounts on each plan',
  input: {},
  output: [{ plan: 'string', accounts: 'number' }],
};

describe('router: ids and paths, before any engine', () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(() => h.close());

  test('a malformed id is 404 without a single SSM call', async () => {
    for (const id of ['EP-00000000A1', 'ep-123', 'ep-00000000a1ff', 'ep-0000000xyz', 'constructor']) {
      const { status, json } = await h.call(`/ep/${id}/healthz`, { key: 'k' });
      assert.equal(status, 404, id);
      assert.equal(json?.error?.code, 'ENDPOINT_NOT_FOUND');
    }
    assert.equal(h.ssm.calls, 0);
  });

  test('an unknown id is 404, and is not looked up again within the TTL', async () => {
    assert.equal((await h.call(`/ep/${C}/v0/query`, { key: 'k', body: {} })).status, 404);
    const calls = h.ssm.calls;
    assert.equal(calls, 1);
    assert.equal((await h.call(`/ep/${C}/healthz`, { key: 'k' })).status, 404);
    assert.equal(h.ssm.calls, calls, 'remembered as missing');
    h.clock.now += TTL_MS;
    assert.equal((await h.call(`/ep/${C}/healthz`, { key: 'k' })).status, 404);
    assert.equal(h.ssm.calls, calls + 1, 'looked up again after the TTL');
  });

  test('unknown ids are remembered in a bounded map: probing random ids cannot grow memory without limit', async () => {
    for (let i = 0; i < 1_100; i++) await h.call(`/ep/ep-${i.toString(16).padStart(10, 'f')}/healthz`, { key: 'k' });
    const calls = h.ssm.calls;
    // The newest ones are still remembered; the oldest were forgotten to stay under the cap.
    await h.call(`/ep/ep-${(1_099).toString(16).padStart(10, 'f')}/healthz`, { key: 'k' });
    assert.equal(h.ssm.calls, calls);
    await h.call(`/ep/ep-${(0).toString(16).padStart(10, 'f')}/healthz`, { key: 'k' });
    assert.equal(h.ssm.calls, calls + 1);
  });

  test('paths outside /ep/<id>/ are 401, root /healthz included', async () => {
    for (const path of ['/healthz', '/', '/v0/query', '/ep//healthz']) {
      const { status, json } = await h.call(path, { key: keyOf(A) });
      assert.equal(status, 401, path);
      assert.equal(json?.error?.code, 'UNAUTHORIZED');
    }
  });
});

const hasDatabase = await isDatabaseAvailable();

describe('tenant cache with live engines', { skip: !hasDatabase && 'demo Postgres is down' }, () => {
  test('each endpoint opens with its own key only; a wrong or missing key is 401', async () => {
    const h = await harness();
    try {
      h.addEndpoint(A);
      h.addEndpoint(B);
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(A) })).status, 200);
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(B) })).status, 401, "another endpoint's key");
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: 'slm_wrong' })).status, 401);
      assert.equal((await h.call(`/ep/${A}/healthz`)).status, 401);
    } finally {
      await h.close();
    }
  });

  test("an slc_ token opens only its own Crystal's route on its own endpoint", async () => {
    const h = await harness();
    try {
      h.addEndpoint(A, { CRYSTAL_TOKENS: JSON.stringify({ k1: 'slc_a' }) });
      h.addEndpoint(B, { CRYSTAL_TOKENS: JSON.stringify({ k9: 'slc_b' }) });
      const own = await h.call(`/ep/${A}/v0/e/k1`, { key: 'slc_a', body: { input: {} } });
      // Past auth: the endpoint itself answers that it has no such Crystal (yet).
      assert.deepEqual([own.status, own.json?.error?.code], [404, 'HANDLER_NOT_FOUND']);
      assert.equal((await h.call(`/ep/${A}/v0/query`, { key: 'slc_a', body: COUNT_PER_PLAN })).status, 401);
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: 'slc_a' })).status, 401);
      assert.equal((await h.call(`/ep/${A}/v0/e/k2`, { key: 'slc_a', body: { input: {} } })).status, 401);
      assert.equal((await h.call(`/ep/${B}/v0/e/k1`, { key: 'slc_a', body: { input: {} } })).status, 401, 'another endpoint');
    } finally {
      await h.close();
    }
  });

  test('concurrent first requests share one engine build', async () => {
    const h = await harness();
    try {
      h.addEndpoint(A);
      const replies = await Promise.all([1, 2, 3].map(() => h.call(`/ep/${A}/healthz`, { key: keyOf(A) })));
      assert.deepEqual(replies.map((r) => r.status), [200, 200, 200]);
      assert.equal(h.built.length, 1);
    } finally {
      await h.close();
    }
  });

  test('settings are re-read after the TTL: same values keep the engine, a new key swaps in place, another engine value rebuilds', async () => {
    const h = await harness({ ttlMs: TTL_MS });
    try {
      h.addEndpoint(A);
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(A) })).status, 200);
      const first = await h.runtimeOf(A);
      const calls = h.ssm.calls;

      h.clock.now += TTL_MS;
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(A) })).status, 200);
      assert.ok(h.ssm.calls > calls, 're-read after the TTL');
      assert.equal(await h.runtimeOf(A), first, 'unchanged settings keep the engine');

      // Auth part: a rotated key and a new Crystal token take effect without a rebuild.
      h.addEndpoint(A, { SLIME_API_KEY: 'slm_rotated', CRYSTAL_TOKENS: JSON.stringify({ k1: 'slc_new' }) });
      h.clock.now += TTL_MS;
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: 'slm_rotated' })).status, 200);
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(A) })).status, 401, 'the old key is gone');
      assert.equal((await h.call(`/ep/${A}/v0/e/k1`, { key: 'slc_new', body: { input: {} } })).status, 404, 'the new token gets past auth');
      assert.equal(await h.runtimeOf(A), first);
      assert.deepEqual(h.closed, []);

      // Engine part: a change waits for the TTL, then rebuilds and closes the old engine.
      h.addEndpoint(A, { SLIME_API_KEY: 'slm_rotated', MAX_GENERATIONS_PER_HOUR: '50' });
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: 'slm_rotated' })).status, 200);
      assert.equal(await h.runtimeOf(A), first, 'still within the TTL');
      h.clock.now += TTL_MS;
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: 'slm_rotated' })).status, 200);
      assert.notEqual(await h.runtimeOf(A), first);
      assert.deepEqual(h.closed, [A]);
    } finally {
      await h.close();
    }
  });

  test('POST /v0/reload drops the cached settings and engine: the next request reads SSM and builds afresh', async () => {
    const h = await harness();
    try {
      h.addEndpoint(A);
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(A) })).status, 200);
      const first = await h.runtimeOf(A);
      assert.equal((await h.call(`/ep/${A}/v0/reload`, { body: {} })).status, 401, 'reload needs the key too');
      const reload = await h.call(`/ep/${A}/v0/reload`, { key: keyOf(A), body: {} });
      assert.equal(reload.status, 204);
      assert.deepEqual(h.closed, [A]);
      const calls = h.ssm.calls;
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(A) })).status, 200);
      assert.equal(h.ssm.calls, calls + 1, 'one fresh read of the endpoint path, within the TTL');
      assert.notEqual(await h.runtimeOf(A), first);
    } finally {
      await h.close();
    }
  });

  test('GET /healthz?fresh=1 re-reads the settings before checking them, in the same call', async () => {
    const h = await harness({ ttlMs: TTL_MS });
    try {
      h.addEndpoint(A);
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(A) })).status, 200);
      // A connector change this instance has not seen yet (its TTL has not passed).
      h.addEndpoint(A, { DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' });
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(A) })).status, 200, 'cached settings still answer');
      const fresh = await h.call(`/ep/${A}/healthz?fresh=1`, { key: keyOf(A) });
      assert.equal(fresh.status, 503, 'the new, broken settings are what got checked');
      assert.equal((await h.call(`/ep/${A}/healthz?fresh=1`, { key: 'wrong' })).status, 401);
    } finally {
      await h.close();
    }
  });

  test('a failed settings check keeps serving the cached endpoint instead of failing it', async () => {
    const h = await harness({ ttlMs: TTL_MS });
    try {
      h.addEndpoint(A);
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(A) })).status, 200);
      h.ssm.failWith = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
      h.clock.now += TTL_MS;
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(A) })).status, 200);
      // An endpoint this instance never saw has nothing to fall back to.
      assert.equal((await h.call(`/ep/${B}/healthz`, { key: keyOf(B) })).status, 500);
    } finally {
      await h.close();
    }
  });

  test('a deleted endpoint is 404 after the TTL, and its engine is closed', async () => {
    const h = await harness({ ttlMs: TTL_MS });
    try {
      h.addEndpoint(A);
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(A) })).status, 200);
      h.ssm.deleteAll(`${ENDPOINTS_SSM_PREFIX}${A}/`);
      h.clock.now += TTL_MS;
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(A) })).status, 404);
      assert.deepEqual(h.closed, [A]);
    } finally {
      await h.close();
    }
  });

  test('past the cap, the least recently used endpoint saves its live runs, then closes', async () => {
    const h = await harness({ maxEntries: 2 });
    try {
      for (const id of [A, B, C]) h.addEndpoint(id);
      // Offline has no reviewer: Liquid (and saved with 3 runs) after 3 runs; 2 more count in memory only.
      for (let run = 0; run < 5; run++) assert.equal((await h.call(`/ep/${A}/v0/query`, { key: keyOf(A), body: COUNT_PER_PLAN })).status, 200);
      const saved = async () => ((await h.savedHandlers(A))[0]?.value as { tier: string; runs: number } | undefined);
      const record = await saved();
      assert.deepEqual([record?.tier, record?.runs], ['liquid', 3]);

      assert.equal((await h.call(`/ep/${B}/healthz`, { key: keyOf(B) })).status, 200);
      assert.deepEqual(h.closed, []);
      assert.equal((await h.call(`/ep/${C}/healthz`, { key: keyOf(C) })).status, 200);
      assert.deepEqual(h.closed, [A], 'A was the least recently used');
      assert.equal((await saved())?.runs, 5, 'live runs saved before the close');
    } finally {
      await h.close();
    }
  });

  test('a missing DATABASE_URL is 503 naming it, for the key holder only, and is retried on the next request', async () => {
    const h = await harness({ ttlMs: TTL_MS });
    try {
      h.ssm.putAll(`${ENDPOINTS_SSM_PREFIX}${A}/`, { SLIME_API_KEY: keyOf(A), SLIME_PROVIDER: 'groq' });
      assert.equal((await h.call(`/ep/${A}/healthz`)).status, 401, 'no cause shown without the key');
      for (let attempt = 0; attempt < 2; attempt++) {
        const { status, json } = await h.call(`/ep/${A}/healthz`, { key: keyOf(A) });
        assert.deepEqual([status, json?.error?.code], [503, 'NOT_READY']);
        assert.match(json?.error?.message ?? '', /DATABASE_URL is not set/);
      }
      assert.equal(h.built.length, 0);
      h.addEndpoint(A);
      h.clock.now += TTL_MS;
      assert.equal((await h.call(`/ep/${A}/healthz`, { key: keyOf(A) })).status, 200, 'a failed build is not cached');
    } finally {
      await h.close();
    }
  });

  test('serving endpoints never writes their settings into process.env', async () => {
    const h = await harness();
    const before = { ...process.env };
    try {
      h.addEndpoint(A);
      h.addEndpoint(B);
      h.ssm.putAll('/slime/shared/', { GROQ_API_KEY: 'gsk_shared' });
      for (const id of [A, B]) assert.equal((await h.call(`/ep/${id}/v0/query`, { key: keyOf(id), body: COUNT_PER_PLAN })).status, 200);
      assert.deepEqual({ ...process.env }, before);
      assert.equal(process.env.SLIME_API_KEY, undefined);
      assert.equal(process.env.GROQ_API_KEY, before.GROQ_API_KEY);
    } finally {
      await h.close();
    }
  });

  test('every instance serves the same requests feed: a cold one is not empty, two warm ones agree', async () => {
    const dynamo = new FakeDynamo();
    const [one, two] = [await harness({ dynamo }), await harness({ dynamo })];
    try {
      for (const h of [one, two]) h.addEndpoint(A);
      // Traffic spread over both instances, as the Lambda spreads it.
      for (const h of [one, two, one]) assert.equal((await h.call(`/ep/${A}/v0/query`, { key: keyOf(A), body: COUNT_PER_PLAN })).status, 200);
      const feeds = await Promise.all([one, two].map(async (h) => (await h.call(`/ep/${A}/v0/events`, { key: keyOf(A) })).json));
      assert.deepEqual(feeds[0], feeds[1], 'both instances list the same feed');
      assert.equal(feeds[0]?.events?.length, 3);
      const cold = await harness({ dynamo });
      try {
        cold.addEndpoint(A);
        assert.deepEqual((await cold.call(`/ep/${A}/v0/events`, { key: keyOf(A) })).json, feeds[0], 'a fresh instance shows it too');
      } finally {
        await cold.close();
      }
    } finally {
      await Promise.all([one.close(), two.close()]);
    }
  });

  test('the Lifecycle data says its Gas rows are this instance only', async () => {
    const h = await harness();
    try {
      h.addEndpoint(A);
      const { status, json } = await h.call(`/ep/${A}/v0/lifecycle`, { key: keyOf(A) });
      assert.deepEqual([status, json?.instance], [200, true]);
    } finally {
      await h.close();
    }
  });
});
