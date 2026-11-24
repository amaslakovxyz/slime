// meta.timingsMs names where a request's time went: total minus the named parts is only
// the engine's own bookkeeping, also when a request waits or a handler is repaired.
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { SlimeConfig, type SlimeOptions } from '../../src/config/slime-config.js';
import type { ReviewedEvent, SlimeEvent } from '../../src/config/events.js';
import { createSlime } from '../../src/create-slime.js';
import type { QueryMeta, QueryTimings, Slime } from '../../src/engine/types.js';
import type { Artifact } from '../../src/artifact/artifact.js';
import type { GenerationRequest, Generator } from '../../src/models/types.js';
import type { Connector } from '../../src/sources/sql/types.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import { artifact, fakeConnector, stubGenerator, stubReviewer } from '../../src/testing/fakes.js';

const ROWS = [{ name: 'Acme' }, { name: 'Globex' }];
const OUTPUT = [{ name: 'string' }];
const MODEL_MS = 120;
const EXPLAIN_MS = 30;
const RUN_MS = 20;
// Timers and the event loop add a few ms per await; anything near this means a part is missing.
const MAX_UNNAMED_MS = 40;
const GOOD = artifact('SELECT name FROM accounts');
const BROKEN = artifact('SELECT nme FROM accounts');

const openInstances: Slime[] = [];
after(() => Promise.all(openInstances.map((slime) => slime.close())));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** EXPLAIN and run take real time and report it, as the Postgres connector does; `nme` fails EXPLAIN. */
function slowConnector(): Connector {
  const base = fakeConnector({ rows: ROWS });
  return {
    ...base,
    check: async (sql) => {
      await sleep(EXPLAIN_MS);
      if (sql.includes('nme')) throw new Error('column "nme" does not exist');
      return { cost: 1, ms: EXPLAIN_MS };
    },
    run: async (sql, params, limits) => {
      await sleep(RUN_MS);
      return { ...(await base.run(sql, params, limits)), ms: RUN_MS };
    },
  };
}

/** Reports the time it really took, as the provider clients do: a late timer under load is model time too. */
function timedGenerator(artifactFor: (request: GenerationRequest) => Artifact, delayMs = MODEL_MS): Generator {
  const inner = stubGenerator(artifactFor, delayMs);
  return {
    ...inner,
    generate: async (request, options) => {
      const startedAt = performance.now();
      const result = await inner.generate(request, options);
      return { ...result, ms: performance.now() - startedAt };
    },
  };
}

async function startSlime(options: Partial<SlimeOptions> = {}): Promise<Slime> {
  const slime = await createSlime(new SlimeConfig({ connector: slowConnector(), store: memoryStore(), generator: timedGenerator(() => GOOD), ...options }));
  openInstances.push(slime);
  return slime;
}

const request = (intent = 'all account names') => ({ intent, input: {}, output: OUTPUT });

function unnamedMs({ total, ...parts }: QueryTimings): number {
  return total - Object.values(parts).reduce((sum, ms) => sum + (ms ?? 0), 0);
}

function assertAccounted(meta: QueryMeta): void {
  const unnamed = unnamedMs(meta.timingsMs);
  assert.ok(unnamed >= -1 && unnamed < MAX_UNNAMED_MS, `total ${meta.timingsMs.total} leaves ${unnamed} ms unnamed: ${JSON.stringify(meta.timingsMs)}`);
}

describe('meta.timingsMs accounts for the whole request', () => {
  test('a miss names the lookup, slot wait, model, checks, run and shape', async () => {
    const slime = await startSlime();
    const { meta } = await slime.query(request());
    const t = meta.timingsMs;
    assert.equal(meta.cache, 'miss');
    assert.equal(meta.attempts, 1);
    for (const part of ['lookup', 'queue', 'generate', 'providerWait', 'checks'] as const) assert.equal(typeof t[part], 'number', `${part} missing`);
    assert.ok(t.checks! >= EXPLAIN_MS - 1, `checks ${t.checks}`);
    assertAccounted(meta);
  });

  test('a repaired miss counts both attempts and both checks', async () => {
    const generator = timedGenerator((req) => (req.previous ? GOOD : BROKEN));
    const slime = await startSlime({ generator });
    const { meta } = await slime.query(request());
    assert.equal(meta.attempts, 2);
    assert.ok(meta.timingsMs.generate! >= 2 * MODEL_MS - 1, `generate ${meta.timingsMs.generate}`);
    assert.ok(meta.timingsMs.checks! >= 2 * EXPLAIN_MS - 1, `checks ${meta.timingsMs.checks}`);
    assertAccounted(meta);
  });

  test("a coalesced request's wait for the shared generation is its queue time", async () => {
    const slime = await startSlime();
    const [first, second] = await Promise.all([slime.query(request()), slime.query(request())]);
    assert.deepEqual([first.meta.cache, second.meta.cache], ['miss', 'coalesced']);
    assert.equal(second.meta.timingsMs.generate, undefined);
    assert.ok(second.meta.timingsMs.queue! >= MODEL_MS - 1, `queue ${second.meta.timingsMs.queue}`);
    assertAccounted(first.meta);
    assertAccounted(second.meta);
  });

  test('a miss that waits for a generation slot reports the wait as queue', async () => {
    const slime = await startSlime({ limits: { maxConcurrentGenerations: 1 } });
    const [first, second] = await Promise.all([slime.query(request('all account names')), slime.query(request('every account name, sorted'))]);
    assert.deepEqual([first.meta.cache, second.meta.cache], ['miss', 'miss']);
    assert.ok(second.meta.timingsMs.queue! >= MODEL_MS - 1, `queue ${second.meta.timingsMs.queue}`);
    assertAccounted(first.meta);
    assertAccounted(second.meta);
  });

  test('a hit names the lookup and the run, and has no generation parts', async () => {
    const slime = await startSlime();
    await slime.query(request());
    const { meta } = await slime.query(request());
    assert.equal(meta.cache, 'hit');
    assert.equal(meta.attempts, undefined);
    for (const part of ['queue', 'generate', 'providerWait', 'checks'] as const) assert.equal(meta.timingsMs[part], undefined, `${part} on a hit`);
    assert.equal(typeof meta.timingsMs.lookup, 'number');
    assertAccounted(meta);
  });

  test('waiting for a sandbox worker is sandboxWait, not shape time', async () => {
    const counting = artifact('SELECT name FROM accounts', [], 'function shape(rows) { return rows.map((row) => ({ name: row.name })) }');
    const slime = await startSlime({ generator: timedGenerator(() => counting, 0) });
    const { meta } = await slime.query(request());
    // A new engine starts its sandbox worker on this first call.
    assert.ok(meta.timingsMs.sandboxWait! > meta.timingsMs.shape, JSON.stringify(meta.timingsMs));
    assertAccounted(meta);
  });
});

describe('review cost', () => {
  test('the reviewed event carries the review call time and tokens', async () => {
    const events: SlimeEvent[] = [];
    const slime = await startSlime({ generator: timedGenerator(() => GOOD, 0), reviewer: stubReviewer(['approve'], 25), tiers: { gasToLiquidRuns: 2 }, onEvent: (event) => events.push(event) });
    await slime.query(request());
    await slime.query(request());
    await slime.flush();
    const reviewed = events.find((event): event is ReviewedEvent => event.type === 'reviewed');
    assert.equal(reviewed?.ms, 25);
    assert.equal(reviewed?.tokens, 15);
  });
});
