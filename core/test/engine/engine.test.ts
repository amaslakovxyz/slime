// The M2 engine against a scripted connector and a stub generator: no database, no model (PLAN.md §7).
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { SlimeConfig, type SlimeOptions } from '../../src/config/slime-config.js';
import type { SlimeEvent } from '../../src/config/options.js';
import { createSlime } from '../../src/create-slime.js';
import { buildDictionary } from '../../src/dictionary/dictionary.js';
import type { HandlerRecord, Slime } from '../../src/engine/types.js';
import { SlimeConfigError, SlimeError, type ErrorCode } from '../../src/shared/errors.js';
import { requestKey } from '../../src/request/key.js';
import { parseRequest, type InputValues, type SlimeRequest } from '../../src/request/parse.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import { artifact, fakeConnector, stubGenerator } from '../../src/testing/fakes.js';

const ROWS = [{ name: 'Acme' }, { name: 'Globex' }];
const OUTPUT = [{ name: 'string' }];
const TOP_ACCOUNTS = 'top N accounts in a country';
const FILTERED_SQL = 'SELECT name FROM accounts WHERE ($1::text IS NULL OR country = $1) AND ($2::text IS NULL OR plan = $2)';
const filteredArtifact = artifact(FILTERED_SQL, ['country', 'plan']);
const topAccounts = (input: InputValues): SlimeRequest => ({ intent: TOP_ACCOUNTS, input, output: OUTPUT });

const openInstances: Slime[] = [];
after(() => Promise.all(openInstances.map((slime) => slime.close())));

async function startSlime(options: Partial<SlimeOptions> = {}): Promise<Slime> {
  const slime = await createSlime(new SlimeConfig({ connector: fakeConnector({ rows: ROWS }), store: memoryStore(), ...options }));
  openInstances.push(slime);
  return slime;
}

function failsWith(code: ErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof SlimeError && error.code === code;
}

function savedRecord(request: SlimeRequest, overrides: Partial<HandlerRecord> = {}): HandlerRecord {
  return {
    key: requestKey(parseRequest(request)),
    intent: request.intent,
    output: request.output,
    artifact: filteredArtifact,
    paramTypes: {},
    provenance: { schemaHash: 'old-schema', dictionaryHash: 'd', promptHash: 'p', model: 'm' },
    tier: 'liquid',
    review: 'approved',
    runs: 3,
    fixtures: [],
    createdAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('engine: Gas path (M2)', () => {
  test('a repeat request is a cache hit, and different input values reuse the handler', async () => {
    const generator = stubGenerator(() => filteredArtifact);
    const slime = await startSlime({ generator });
    const first = await slime.query(topAccounts({ country: 'DE', plan: null }));
    const second = await slime.query(topAccounts({ country: 'FR', plan: 'gold' }));
    assert.deepEqual(first.data, ROWS);
    assert.deepEqual([first.meta.cache, second.meta.cache], ['miss', 'hit']);
    assert.equal(generator.calls, 1);
  });

  test('one handler serves every combination of null filters (R5)', async () => {
    const generator = stubGenerator(() => filteredArtifact);
    const slime = await startSlime({ generator });
    for (const country of ['DE', null]) {
      for (const plan of ['gold', null]) await slime.query(topAccounts({ country, plan }));
    }
    assert.equal(generator.calls, 1);
  });

  test("a parameter's type changing after its first non-null value gives INVALID_REQUEST (R4)", async () => {
    const slime = await startSlime({ generator: stubGenerator(() => filteredArtifact) });
    await slime.query(topAccounts({ country: 'DE', plan: null }));
    await assert.rejects(slime.query(topAccounts({ country: 49, plan: null })), failsWith('INVALID_REQUEST'));
  });

  test('more rows than input.limit is a failed run (R6)', async () => {
    const slime = await startSlime({ generator: stubGenerator(() => artifact('SELECT name FROM accounts LIMIT $1', ['limit'])), limits: { maxRepairs: 0 } });
    await assert.rejects(slime.query({ intent: 'first N accounts', input: { limit: 1 }, output: OUTPUT }), failsWith('INVALID_HANDLER'));
  });

  test('concurrent identical requests share one generation', async () => {
    const generator = stubGenerator(() => filteredArtifact, 50);
    const slime = await startSlime({ generator });
    const results = await Promise.all([1, 2, 3].map(() => slime.query(topAccounts({ country: 'DE', plan: null }))));
    assert.equal(generator.calls, 1);
    assert.deepEqual(results.map(({ meta }) => meta.cache).sort(), ['coalesced', 'coalesced', 'miss']);
  });

  test('the hourly limit gives GENERATION_RATE_LIMITED, which is retryable', async () => {
    const slime = await startSlime({ generator: stubGenerator(() => filteredArtifact), limits: { maxGenerationsPerHour: 1 } });
    await slime.query(topAccounts({ country: 'DE', plan: null }));
    const otherIntent = { ...topAccounts({ country: 'DE', plan: null }), intent: 'accounts in a country by plan' };
    await assert.rejects(slime.query(otherIntent), (error) => failsWith('GENERATION_RATE_LIMITED')(error) && (error as SlimeError).retryable);
  });

  test('runs the shaping function in the sandbox and checks its result against output', async () => {
    const counting = artifact('SELECT name FROM accounts', [], 'function shape(rows) { return { count: rows.length } }');
    const slime = await startSlime({ generator: stubGenerator(() => counting) });
    const { data, meta } = await slime.query({ intent: 'how many accounts', output: { count: 'integer' } });
    assert.deepEqual(data, { count: 2 });
    assert.equal(meta.shapeJs, counting.shapeJs);
  });
});

describe('engine: modes and saved handlers (§4.7, R8)', () => {
  test('locked mode serves a saved handler and refuses to generate', async () => {
    const request = topAccounts({ country: 'DE', plan: null });
    const store = memoryStore();
    await store.put('handlers', savedRecord(request).key, savedRecord(request));
    const slime = await startSlime({ store });

    const { data, meta } = await slime.query(request);
    assert.deepEqual(data, ROWS);
    assert.deepEqual([meta.tier, meta.cache], ['liquid', 'hit']);
    await assert.rejects(slime.query({ ...request, intent: 'some other question' }), failsWith('HANDLER_NOT_FOUND'));
  });

  test('locked mode warns once at startup about handlers made against another schema', async () => {
    const request = topAccounts({ country: 'DE', plan: null });
    const store = memoryStore();
    await store.put('handlers', savedRecord(request).key, savedRecord(request));
    const events: SlimeEvent[] = [];
    await startSlime({ store, onEvent: (event) => events.push(event) });
    assert.deepEqual(events.map(({ type }) => type), ['warning']);
  });

  test('explore mode regenerates a saved handler whose provenance changed', async () => {
    const request = topAccounts({ country: 'DE', plan: null });
    const store = memoryStore();
    await store.put('handlers', savedRecord(request).key, savedRecord(request));
    const generator = stubGenerator(() => filteredArtifact);
    const slime = await startSlime({ store, generator });
    assert.equal((await slime.query(request)).meta.cache, 'miss');
    assert.equal(generator.calls, 1);
  });

  test('changing rules changes the dictionary and regenerates a saved handler in explore mode (D6)', async () => {
    const request = topAccounts({ country: 'DE', plan: null });
    const schema = await fakeConnector().describe();
    const savedUnderRules = (rules: string[]): HandlerRecord => {
      const dictionary = buildDictionary({ schema, glossary: {}, rules });
      const provenance = { schemaHash: dictionary.schemaHash, dictionaryHash: dictionary.hash, promptHash: 'stub-prompt', model: 'stub-model' };
      return savedRecord(request, { provenance });
    };
    const cacheWith = async (rules: string[]) => {
      const store = memoryStore();
      const record = savedUnderRules(['Count only paid invoices.']);
      await store.put('handlers', record.key, record);
      const slime = await startSlime({ store, rules, generator: stubGenerator(() => filteredArtifact) });
      return (await slime.query(request)).meta.cache;
    };
    assert.equal(await cacheWith(['Count only paid invoices.']), 'hit');
    assert.equal(await cacheWith(['Count open invoices too.']), 'miss');
  });

  test('generated code is in meta only in explore mode (R9, R11)', async () => {
    const request = topAccounts({ country: 'DE', plan: null });
    const explore = await startSlime({ generator: stubGenerator(() => filteredArtifact) });
    assert.equal((await explore.query(request)).meta.sql, FILTERED_SQL);

    const store = memoryStore();
    await store.put('handlers', savedRecord(request).key, savedRecord(request));
    const locked = await startSlime({ store });
    const { meta } = await locked.query(request);
    assert.deepEqual([meta.sql, meta.shapeJs, meta.assumptions], [undefined, undefined, undefined]);
  });
});

describe('engine: startup, warnings, events and eviction', () => {
  test('refuses to start when the database user can write', async () => {
    await assert.rejects(createSlime(new SlimeConfig({ connector: fakeConnector({ isSafe: false }), store: memoryStore() })), SlimeConfigError);
  });

  test('a literal in the intent is a warning, not an error (R7)', async () => {
    const slime = await startSlime({ generator: stubGenerator(() => artifact('SELECT name FROM accounts')) });
    const { meta } = await slime.query({ intent: 'accounts created in 2024', output: OUTPUT });
    assert.equal(meta.warnings.length, 1);
    assert.match(meta.warnings[0]!, /a number/);
  });

  test('emits generated and error events (C11)', async () => {
    const events: SlimeEvent[] = [];
    const slime = await startSlime({ generator: stubGenerator(() => filteredArtifact), onEvent: (event) => events.push(event) });
    await slime.query(topAccounts({ country: 'DE', plan: null }));
    await slime.query(topAccounts({ country: 49, plan: null })).catch(() => {});
    assert.deepEqual(events.map(({ type }) => type), ['generated', 'error']);
  });

  test('evict removes a handler, so the next request generates again', async () => {
    const generator = stubGenerator(() => filteredArtifact);
    const slime = await startSlime({ generator });
    const { meta } = await slime.query(topAccounts({ country: 'DE', plan: null }));
    assert.equal(await slime.evict(meta.handlerKey), true);
    assert.equal(await slime.evict(meta.handlerKey), false);
    await slime.query(topAccounts({ country: 'DE', plan: null }));
    assert.equal(generator.calls, 2);
  });

  test('stats and handlers describe what is cached', async () => {
    const slime = await startSlime({ generator: stubGenerator(() => filteredArtifact) });
    await slime.query(topAccounts({ country: 'DE', plan: null }));
    assert.deepEqual(slime.stats(), { mode: 'explore', handlers: { gas: 1, liquid: 0 }, generationsThisHour: 1, generationsInFlight: 0 });
    assert.deepEqual(slime.handlers().map(({ intent, tier, runs }) => ({ intent, tier, runs })), [{ intent: TOP_ACCOUNTS, tier: 'gas', runs: 1 }]);
  });
});
