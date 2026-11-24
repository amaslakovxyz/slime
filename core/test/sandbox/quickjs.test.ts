import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { SlimeError } from '../../src/shared/errors.js';
import { QuickJSRunner } from '../../src/sandbox/quickjs/quickjs-runner.js';

const LIMITS = { timeoutMs: 200, memoryBytes: 32 * 1024 * 1024 };
const STUCK_IN_NATIVE_CALL = 'function shape() { const a = []; while (true) a.push("x".repeat(1e6)) }';
const runner = new QuickJSRunner();
after(() => runner.close());

const shape = (code: string, rows: unknown[] = [], input: Record<string, unknown> = {}) => runner.run({ code, rows, input }, LIMITS);

async function sandboxFailure(code: string): Promise<{ message: string; ms: number }> {
  const startedAt = performance.now();
  const error = await shape(code).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof SlimeError, 'expected a SlimeError');
  assert.equal(error.code, 'SANDBOX_ERROR');
  return { message: error.message, ms: performance.now() - startedAt };
}

describe('shaping sandbox (C3)', () => {
  test('runs a shaping function on rows and input', async () => {
    assert.deepEqual(await shape('function shape(rows, input) { return rows.map(r => r.n * input.k) }', [{ n: 1 }, { n: 2 }], { k: 10 }), [10, 20]);
  });

  test('has no access to the host process, modules or network', async () => {
    assert.match((await sandboxFailure('function shape() { return process.env }')).message, /process/);
    assert.match((await sandboxFailure('function shape() { return require("fs") }')).message, /require/);
    assert.match((await sandboxFailure('function shape() { return fetch("http://x") }')).message, /fetch/);
  });

  test('interrupts an infinite loop at the time limit', async () => {
    const { ms } = await sandboxFailure('function shape() { while (true) {} }');
    assert.ok(ms < 1_000, `took ${ms} ms`);
  });

  test('kills a worker stuck in a long native call', async () => {
    const { ms } = await sandboxFailure(STUCK_IN_NATIVE_CALL);
    assert.ok(ms < 1_500, `took ${ms} ms`);
  });

  test('keeps working after a worker was killed, including in parallel', async () => {
    await sandboxFailure(STUCK_IN_NATIVE_CALL);
    const doubled = await Promise.all([1, 2, 3, 4, 5].map((n) => shape('function shape(r, i) { return i.n * 2 }', [], { n })));
    assert.deepEqual(doubled, [2, 4, 6, 8, 10]);
  });

  test("reports the wait for a worker: a cold start, then next to nothing", async () => {
    const fresh = new QuickJSRunner();
    try {
      const [cold, warm] = [{ waitMs: 0 }, { waitMs: 0 }];
      await fresh.run({ code: 'function shape(rows) { return rows }', rows: [], input: {} }, LIMITS, cold);
      await fresh.run({ code: 'function shape(rows) { return rows }', rows: [], input: {} }, LIMITS, warm);
      assert.ok(cold.waitMs > warm.waitMs, `cold ${cold.waitMs} ms, warm ${warm.waitMs} ms`);
      assert.ok(warm.waitMs < 5, `warm ${warm.waitMs} ms`);
    } finally {
      await fresh.close();
    }
  });

  test('reports a shaping function that returns nothing', async () => {
    assert.match((await sandboxFailure('function shape() {}')).message, /returned nothing/);
  });
});

describe('shape(data, input) for multi-source handlers (MS3)', () => {
  test('the first argument may be an object of step rows', async () => {
    const runner = new QuickJSRunner();
    try {
      const code = 'function shape(data, input) { const open = new Map(); for (const f of data.feedback) open.set(f.account, (open.get(f.account) ?? 0) + 1); return data.accounts.map((a) => ({ name: a.name, open: open.get(a.name) ?? 0 })); }';
      const data = { accounts: [{ name: 'Acme' }, { name: 'Globex' }], feedback: [{ account: 'Acme' }, { account: 'Acme' }] };
      assert.deepEqual(await runner.run({ code, rows: data, input: {} }, { timeoutMs: 1_000, memoryBytes: 32 * 1024 * 1024 }), [
        { name: 'Acme', open: 2 },
        { name: 'Globex', open: 0 },
      ]);
    } finally {
      await runner.close();
    }
  });

  test('a pg Date in v1 rows still becomes an ISO string', async () => {
    const runner = new QuickJSRunner();
    try {
      const rows = [{ at: new Date('2026-11-21T10:00:00Z') }];
      assert.deepEqual(await runner.run({ code: 'function shape(rows) { return rows; }', rows, input: {} }, { timeoutMs: 1_000, memoryBytes: 32 * 1024 * 1024 }), [{ at: '2026-11-21T10:00:00.000Z' }]);
    } finally {
      await runner.close();
    }
  });
});
