// Gas → Liquid and the review loop (PLAN.md §7, M4 promotion rule), with stub models.
import { sqlOf } from '../../src/artifact/artifact.js';
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { SlimeConfig, type SlimeOptions } from '../../src/config/slime-config.js';
import type { SlimeEvent } from '../../src/config/events.js';
import { createSlime } from '../../src/create-slime.js';
import type { QueryMeta, Slime } from '../../src/engine/types.js';
import type { HandlerRecord } from '../../src/handler/record.js';
import type { GenerationRequest } from '../../src/models/types.js';
import type { SlimeStore } from '../../src/stores/types.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import { artifact, fakeConnector, fakeGenerator, stubGenerator, stubReviewer } from '../../src/testing/fakes.js';

const ROWS = [{ name: 'Acme' }];
const REQUEST = { intent: 'accounts in a country', input: { country: 'DE' }, output: [{ name: 'string' }] };
const FIRST_SQL = 'SELECT name FROM accounts WHERE ($1::text IS NULL OR country = $1::text)';
const REVISED_SQL = `${FIRST_SQL} ORDER BY name`;
const RUNS_TO_PROMOTE = 3;

const openInstances: Slime[] = [];
after(() => Promise.all(openInstances.map((slime) => slime.close())));

interface Started {
  slime: Slime;
  store: SlimeStore;
  events: SlimeEvent[];
}

async function startSlime(options: Partial<SlimeOptions> = {}): Promise<Started> {
  const store = options.store ?? memoryStore();
  const events: SlimeEvent[] = [];
  const config = new SlimeConfig({ connector: fakeConnector({ rows: ROWS }), store, generator: fakeGenerator(), onEvent: (event) => events.push(event), ...options });
  const slime = await createSlime(config);
  openInstances.push(slime);
  return { slime, store, events };
}

/** Runs the request `times` times with different values, then waits for background work. */
async function runAndFlush(slime: Slime, times = RUNS_TO_PROMOTE): Promise<QueryMeta[]> {
  const metas: QueryMeta[] = [];
  for (let run = 0; run < times; run++) metas.push((await slime.query({ ...REQUEST, input: { country: `C${run}` } })).meta);
  await slime.flush();
  return metas;
}

async function savedHandler(store: SlimeStore, key: string): Promise<HandlerRecord | undefined> {
  return (await store.get('handlers', key)) as HandlerRecord | undefined;
}

const firstThenRevised = (request: GenerationRequest) => artifact(request.previous ? REVISED_SQL : FIRST_SQL, ['country']);
const eventTypes = (events: SlimeEvent[]) => events.map(({ type }) => type);

describe('promotion to Liquid (M4)', () => {
  test('without a reviewer, a handler is promoted after gasToLiquidRuns runs and marked review "none"', async () => {
    const { slime, store, events } = await startSlime({ generator: stubGenerator(firstThenRevised) });
    const metas = await runAndFlush(slime);
    const key = metas[0]!.handlerKey;
    assert.deepEqual(metas.map(({ tier }) => tier), ['gas', 'gas', 'liquid']);
    assert.deepEqual([(await savedHandler(store, key))?.tier, (await savedHandler(store, key))?.review], ['liquid', 'none']);
    assert.deepEqual(eventTypes(events), ['generated', 'promoted']);
  });

  test('with a reviewer, an approved handler is promoted and saved; flush waits for the review', async () => {
    const reviewer = stubReviewer(['approve'], 30);
    const { slime, store, events } = await startSlime({ generator: stubGenerator(firstThenRevised), reviewer });
    const metas = await runAndFlush(slime);
    assert.equal(metas[2]!.review, 'pending');
    assert.equal((await savedHandler(store, metas[0]!.handlerKey))?.review, 'approved');
    assert.deepEqual(eventTypes(events), ['generated', 'reviewed', 'promoted']);
    assert.equal(reviewer.calls, 1);
  });

  test("a rejected handler is revised with the reviewer's notes, re-reviewed, then promoted", async () => {
    const requests: GenerationRequest[] = [];
    const generator = stubGenerator((request) => (requests.push(request), firstThenRevised(request)));
    const { slime, store, events } = await startSlime({ generator, reviewer: stubReviewer(['reject', 'approve']) });
    const metas = await runAndFlush(slime);
    const saved = await savedHandler(store, metas[0]!.handlerKey);
    assert.match(requests[1]?.previous?.error ?? '', /reviewer rejected this handler: ranks the least active/);
    assert.deepEqual([saved && sqlOf(saved.artifact), saved?.runs], [REVISED_SQL, 1]);
    assert.deepEqual(eventTypes(events), ['generated', 'reviewed', 'generated', 'reviewed', 'promoted']);
  });

  test('after maxReviews rejections the handler stays Gas, is marked rejected, and is not saved', async () => {
    const generator = stubGenerator(firstThenRevised);
    const { slime, store } = await startSlime({ generator, reviewer: stubReviewer(['reject']), tiers: { maxReviews: 2 } });
    const metas = await runAndFlush(slime);
    const extraRun = await slime.query(REQUEST);
    assert.deepEqual([extraRun.meta.tier, extraRun.meta.review], ['gas', 'rejected']);
    assert.equal(await savedHandler(store, metas[0]!.handlerKey), undefined);
    assert.equal(generator.calls, 2, 'one generation and one revision');
  });

  test('a failed review call emits an error and is retried after the next run', async () => {
    const reviewer = stubReviewer(['throw', 'approve']);
    const { slime, store, events } = await startSlime({ generator: stubGenerator(firstThenRevised), reviewer });
    const metas = await runAndFlush(slime);
    assert.ok(eventTypes(events).includes('error'));
    await runAndFlush(slime, 1);
    assert.equal((await savedHandler(store, metas[0]!.handlerKey))?.tier, 'liquid');
    assert.equal(reviewer.calls, 2);
  });
});

describe('after a restart (R8)', () => {
  test('a promoted handler is served from the store, with no model call', async () => {
    const first = await startSlime({ generator: stubGenerator(firstThenRevised) });
    await runAndFlush(first.slime);

    const generator = stubGenerator(firstThenRevised);
    const restarted = await startSlime({ store: first.store, generator });
    const { data, meta } = await restarted.slime.query(REQUEST);
    assert.deepEqual(data, ROWS);
    assert.deepEqual([meta.tier, meta.cache, generator.calls], ['liquid', 'hit', 0]);
  });
});
