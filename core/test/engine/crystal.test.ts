// Crystal handlers whose shape is source text (hosts that load modules as data) and
// the sandbox runner a host shares across engines.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SlimeConfig } from '../../src/config/slime-config.js';
import { createSlime } from '../../src/create-slime.js';
import type { CrystalHandler, CrystalRegistry } from '../../src/handler/crystal.js';
import { requestKey } from '../../src/request/key.js';
import { parseRequest } from '../../src/request/parse.js';
import { QuickJSRunner } from '../../src/sandbox/quickjs/quickjs-runner.js';
import type { SandboxRunner } from '../../src/sandbox/types.js';
import { SlimeError } from '../../src/shared/errors.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import { artifact, fakeConnector, fakeGenerator, stubGenerator } from '../../src/testing/fakes.js';

const ROWS = [
  { name: 'Acme', cents: 1250 },
  { name: 'Globex', cents: 900 },
];
const EUROS = [
  { name: 'Acme', euros: 12.5 },
  { name: 'Globex', euros: 9 },
];
const REQUEST = { intent: 'accounts with their balance in euros', input: { country: 'DE' }, output: [{ name: 'string', euros: 'number' }] };
const KEY = requestKey(parseRequest(REQUEST));
const SQL = 'SELECT name, cents FROM accounts WHERE country = $1::text';
const SHAPE_SOURCE = 'function shape(rows) { return rows.map((r) => ({ name: r.name, euros: r.cents / 100 })); }';
// Exponential recursion with a shallow stack: it never overflows, it just never ends.
const ENDLESS_RECURSION = 'function shape(rows) { function grow(n) { return n > 40 ? 0 : grow(n + 1) + grow(n + 1); } return grow(0); }';
const SHAPE_TIMEOUT_MS = 200;

function crystalWith(shape: CrystalHandler['shape']): CrystalRegistry {
  return {
    [KEY]: { sql: SQL, params: ['country'], shape, intent: REQUEST.intent, output: REQUEST.output, paramTypes: { country: 'string' }, schemaHash: 'schema', review: 'approved' },
  };
}

async function slimeWith(crystal: CrystalRegistry, runner?: SandboxRunner) {
  const config = new SlimeConfig({ connector: fakeConnector({ rows: ROWS }), store: memoryStore(), generator: fakeGenerator(), crystal, limits: { shapeTimeoutMs: SHAPE_TIMEOUT_MS } });
  return createSlime(config, runner ? { runner } : {});
}

/**
 * Counts a recurring timer's ticks: the event loop of this process is free while they grow.
 * Real time on purpose: a fake clock cannot show that a shape blocks the event loop.
 */
function tickCounter(): { ticks: () => number; stop: () => void } {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  return { ticks: () => ticks, stop: () => clearInterval(timer) };
}

describe('Crystal shapes as source text', () => {
  test('a string shape answers with the same data as the function form', async () => {
    const asFunction = await slimeWith(crystalWith((rows) => rows.map((r) => ({ name: r.name, euros: (r.cents as number) / 100 }))));
    const asSource = await slimeWith(crystalWith(SHAPE_SOURCE));
    try {
      const fromFunction = await asFunction.query(REQUEST);
      const fromSource = await asSource.query(REQUEST);
      assert.deepEqual(fromFunction.data, EUROS);
      assert.deepEqual(fromSource.data, EUROS);
      assert.deepEqual([fromSource.meta.tier, fromSource.meta.cache], ['crystal', 'hit']);
    } finally {
      await Promise.all([asFunction.close(), asSource.close()]);
    }
  });

  test('a string shape that never ends fails at the shape time limit, and this process stays responsive', async () => {
    const slime = await slimeWith(crystalWith(ENDLESS_RECURSION));
    const counter = tickCounter();
    const startedAt = performance.now();
    try {
      const error = await slime.query(REQUEST).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof SlimeError, 'expected a SlimeError');
      assert.equal(error.code, 'SANDBOX_ERROR');
      assert.match(error.message, new RegExp(`longer than ${SHAPE_TIMEOUT_MS} ms`));
      assert.ok(performance.now() - startedAt < 2_000, 'stopped near the limit');
      assert.ok(counter.ticks() >= 5, `timers kept firing while the shape ran (${counter.ticks()} ticks)`);
    } finally {
      counter.stop();
      await slime.close();
    }
  });
});

describe('an injected sandbox runner', () => {
  test('engine.close() leaves it running for the other engines that share it', async () => {
    const runner = new QuickJSRunner();
    try {
      const first = await slimeWith(crystalWith(SHAPE_SOURCE), runner);
      const second = await slimeWith(crystalWith(SHAPE_SOURCE), runner);
      await first.close();
      assert.deepEqual((await second.query(REQUEST)).data, EUROS);
      await second.close();
      assert.deepEqual(await runner.run({ code: 'function shape(rows) { return rows.length; }', rows: [1, 2], input: {} }, { timeoutMs: 500, memoryBytes: 16 * 1024 * 1024 }), 2);
    } finally {
      await runner.close();
    }
  });
});

describe('a Crystal that no longer fits the data', () => {
  const DRIFTED_SQL = 'SELECT name, balance_cents FROM accounts WHERE country = $1::text';

  /** Rejects the drifted column like Postgres after a migration renamed it; answers the rest with ROWS. */
  function migratedConnector() {
    const base = fakeConnector({ rows: ROWS });
    return {
      ...base,
      run: async (sql: string, params: unknown[], limits: { timeoutMs: number; rowCap: number }) => {
        if (sql.includes('balance_cents')) throw new SlimeError('QUERY_ERROR', 'column "balance_cents" does not exist');
        return base.run(sql, params, limits);
      },
    };
  }

  test('falls back to a generated handler, says so in meta, and warns once', async () => {
    const events: string[] = [];
    const generator = stubGenerator(() => artifact(SQL, ['country'], SHAPE_SOURCE));
    const crystal = { [KEY]: { ...crystalWith(SHAPE_SOURCE)[KEY]!, sql: DRIFTED_SQL } };
    const slime = await createSlime(new SlimeConfig({ connector: migratedConnector(), store: memoryStore(), generator, crystal, onEvent: (event) => event.type === 'warning' && events.push(event.message) }));
    try {
      const first = await slime.query(REQUEST);
      const second = await slime.query({ ...REQUEST, input: { country: 'FR' } });
      assert.deepEqual(first.data, EUROS);
      assert.deepEqual([first.meta.tier, second.meta.tier, generator.calls], ['gas', 'gas', 1]);
      assert.match(first.meta.warnings.join(), /The Crystal handler failed \(QUERY_ERROR\)/);
      assert.equal(events.filter((message) => /failed and falls back: QUERY_ERROR/.test(message)).length, 1);
    } finally {
      await slime.close();
    }
  });

  test('a bad input is the caller\'s error, not a reason to fall back', async () => {
    const generator = stubGenerator(() => artifact(SQL, ['country'], SHAPE_SOURCE));
    const slime = await createSlime(new SlimeConfig({ connector: fakeConnector({ rows: ROWS }), store: memoryStore(), generator, crystal: crystalWith(SHAPE_SOURCE) }));
    try {
      await assert.rejects(slime.query({ ...REQUEST, input: { country: 49 } }), { code: 'INVALID_REQUEST' });
      assert.equal(generator.calls, 0);
    } finally {
      await slime.close();
    }
  });
});
