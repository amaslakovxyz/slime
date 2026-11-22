// The engine records which layers each request passed, on every route and every refusal (request trace design).
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { SlimeConfig, type SlimeOptions } from '../../src/config/slime-config.js';
import { createSlime } from '../../src/create-slime.js';
import type { Slime } from '../../src/engine/types.js';
import type { CrystalRegistry } from '../../src/handler/crystal.js';
import { requestKey } from '../../src/request/key.js';
import { SlimeError } from '../../src/shared/errors.js';
import type { LayerSpan } from '../../src/shared/trace.js';
import { parseRequest, type SlimeRequest } from '../../src/request/parse.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import { artifact, fakeConnector, stubGenerator, stubReviewer } from '../../src/testing/fakes.js';

const ROWS = [{ name: 'Acme' }, { name: 'Globex' }];
const REQUEST: SlimeRequest = { intent: 'accounts in a country', input: { country: 'DE-SECRET' }, output: [{ name: 'string' }] };
const GOOD = artifact('SELECT name FROM accounts WHERE country = $1', ['country']);

const open: Slime[] = [];
after(() => Promise.all(open.map((s) => s.close())));
async function start(options: Partial<SlimeOptions> = {}): Promise<Slime> {
  const slime = await createSlime(new SlimeConfig({ connector: fakeConnector({ rows: ROWS }), store: memoryStore(), generator: stubGenerator(() => GOOD), ...options }));
  open.push(slime);
  return slime;
}
const pairs = (spans: LayerSpan[] | undefined) => (spans ?? []).map((s) => `${s.layer}:${s.status}${s.attempt ? `#${s.attempt}` : ''}`);
async function refusal(slime: Slime, request: SlimeRequest = REQUEST): Promise<SlimeError> {
  try {
    await slime.query(request);
  } catch (error) {
    assert.ok(error instanceof SlimeError);
    return error;
  }
  throw new Error('expected a refusal');
}

describe('engine trace: answered requests', () => {
  test('a miss records every layer of the generation, with attempt numbers', async () => {
    const slime = await start();
    const { meta } = await slime.query(REQUEST);
    assert.deepEqual(pairs(meta.trace), ['key:pass', 'route:pass', 'limits:pass', 'generate:pass#1', 'lint:pass#1', 'cost:pass#1', 'execute:pass#1', 'shape:skip#1', 'output:pass#1', 'cache:pass', 'review:skip']);
    const notes = Object.fromEntries(meta.trace!.map((s) => [s.layer, s.note]));
    assert.equal(notes['key'], 'inputs: country');
    assert.equal(notes['route'], 'cache miss → generate');
    assert.match(notes['limits']!, /^1 of 200 this hour$/);
    assert.equal(notes['cost'], 'cost 1 of 1000000');
    assert.equal(notes['cache'], 'kept as Gas · 1 of 3 runs to Liquid');
    assert.equal(notes['review'], 'no reviewer configured');
  });

  test('a repaired attempt stays in the trace', async () => {
    let calls = 0;
    // Attempt 1 binds a parameter that is not an input name: INVALID_HANDLER at lint, which a repair can fix.
    const generator = stubGenerator(() => (++calls === 1 ? artifact('SELECT name FROM accounts WHERE country = $1', ['nope']) : GOOD));
    const slime = await start({ generator });
    const { meta } = await slime.query(REQUEST);
    const attempts = pairs(meta.trace).filter((p) => /#\d/.test(p));
    assert.deepEqual(attempts.slice(0, 2), ['generate:pass#1', 'lint:stop#1']);
    assert.ok(attempts.includes('output:pass#2'));
  });

  test('a hit skips generation and reports the Gas progress', async () => {
    const slime = await start();
    await slime.query(REQUEST);
    const { meta } = await slime.query(REQUEST);
    assert.deepEqual(pairs(meta.trace), ['key:pass', 'route:pass', 'limits:skip', 'generate:skip', 'lint:skip', 'cost:skip', 'execute:pass', 'shape:skip', 'output:pass', 'cache:pass', 'review:skip']);
    assert.equal(meta.trace!.find((s) => s.layer === 'route')!.note, 'cache hit · gas');
    assert.equal(meta.trace!.find((s) => s.layer === 'cache')!.note, '2 of 3 runs to Liquid');
  });

  test('a coalesced request records the wait as a skipped generate', async () => {
    const slime = await start({ generator: stubGenerator(() => GOOD, 30) });
    const [, second] = await Promise.all([slime.query(REQUEST), slime.query(REQUEST)]);
    assert.equal(second.meta.cache, 'coalesced');
    const generate = second.meta.trace!.find((s) => s.layer === 'generate')!;
    assert.equal(generate.status, 'skip');
    assert.ok((generate.ms ?? 0) > 0);
    assert.equal(second.meta.trace!.find((s) => s.layer === 'route')!.note, 'same request already generating → joined it');
  });

  test('a configured reviewer shows when the review starts', async () => {
    const slime = await start({ reviewer: stubReviewer(['approve']) });
    const { meta } = await slime.query(REQUEST);
    assert.equal(meta.trace!.find((s) => s.layer === 'review')!.note, 'review starts at 3 runs');
  });

  test('no trace note carries an input value', async () => {
    const slime = await start();
    const { meta } = await slime.query(REQUEST);
    assert.ok(!JSON.stringify(meta.trace).includes('DE-SECRET'));
  });
});

describe('engine trace: refused requests', () => {
  test('a write the model refuses stops at generate, with the key', async () => {
    const generator = stubGenerator(() => ({ ...GOOD, unsatisfiable: 'this would delete rows' }));
    const error = await refusal(await start({ generator }));
    assert.equal(error.code, 'WRITE_REFUSED');
    assert.equal(error.trace!.at(-1)!.layer, 'generate');
    assert.equal(error.trace!.at(-1)!.status, 'stop');
    assert.ok(error.handlerKey);
    assert.equal(JSON.stringify(error.toJSON()).includes('trace'), false, 'toJSON is unchanged');
  });

  test('SQL that writes stops at lint', async () => {
    const generator = stubGenerator(() => artifact('DELETE FROM accounts WHERE country = $1', ['country']));
    const error = await refusal(await start({ generator }));
    assert.equal(error.code, 'WRITE_REFUSED');
    assert.deepEqual(pairs(error.trace).slice(-2), ['generate:pass#1', 'lint:stop#1']);
  });

  test('an expensive plan stops at cost on every attempt', async () => {
    const error = await refusal(await start({ connector: fakeConnector({ rows: ROWS, cost: 5_000_000 }) }));
    assert.equal(error.code, 'QUERY_TOO_EXPENSIVE');
    assert.deepEqual(pairs(error.trace).filter((p) => p.startsWith('cost')), ['cost:stop#1', 'cost:stop#2']);
    assert.equal(error.trace!.at(-1)!.layer, 'cost');
  });

  test('the hourly generation cap stops at limits before any model call', async () => {
    const slime = await start({ limits: { maxGenerationsPerHour: 1 } });
    await slime.query(REQUEST);
    const error = await refusal(slime, { ...REQUEST, intent: 'another intent' });
    assert.equal(error.code, 'GENERATION_RATE_LIMITED');
    assert.deepEqual(pairs(error.trace), ['key:pass', 'route:pass', 'limits:stop']);
  });

  test('a bad request stops at key, without a handler key', async () => {
    const error = await refusal(await start(), { intent: '', input: {}, output: [{ name: 'string' }] } as SlimeRequest);
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.deepEqual(pairs(error.trace), ['key:stop']);
    assert.equal(error.handlerKey, undefined);
  });

  test('coalesced requests that fail together each get their own trace', async () => {
    const generator = stubGenerator(() => ({ ...GOOD, unsatisfiable: 'this would delete rows' }), 20);
    const slime = await start({ generator });
    const [a, b] = await Promise.allSettled([slime.query(REQUEST), slime.query(REQUEST)]);
    assert.equal(a.status, 'rejected');
    assert.equal(b.status, 'rejected');
    const ea = (a as PromiseRejectedResult).reason as SlimeError;
    const eb = (b as PromiseRejectedResult).reason as SlimeError;
    assert.notEqual(ea, eb);
    assert.ok(pairs(ea.trace).includes('limits:pass'));
    assert.ok(pairs(eb.trace).includes('limits:skip'));
  });

  test('a Crystal that drifted falls back and the route note shows the failure', async () => {
    const DRIFTED_SQL = 'SELECT name, balance_cents FROM accounts WHERE country = $1::text';
    const SQL = 'SELECT name FROM accounts WHERE country = $1';
    const migratedConnector = () => {
      const base = fakeConnector({ rows: ROWS });
      return {
        ...base,
        run: async (sql: string, params: unknown[], limits: { timeoutMs: number; rowCap: number }) => {
          if (sql.includes('balance_cents')) throw new SlimeError('QUERY_ERROR', 'column "balance_cents" does not exist');
          return base.run(sql, params, limits);
        },
      };
    };
    const generator = stubGenerator(() => artifact(SQL, ['country']));
    const key = requestKey(parseRequest(REQUEST));
    const crystal: CrystalRegistry = { [key]: { sql: DRIFTED_SQL, params: ['country'], shape: null, intent: REQUEST.intent, output: REQUEST.output, paramTypes: { country: 'string' }, schemaHash: 'schema', review: 'approved' } };
    const slime = await createSlime(new SlimeConfig({ connector: migratedConnector(), store: memoryStore(), generator, crystal }));
    open.push(slime);
    const { meta } = await slime.query(REQUEST);
    assert.equal(meta.tier, 'gas');
    assert.match(meta.trace!.find((s) => s.layer === 'route')!.note!, /^Crystal failed \(QUERY_ERROR\) → cache miss → generate$/);
  });
});
