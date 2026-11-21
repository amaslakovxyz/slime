import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { SlimeError } from '../src/shared/errors.js';
import { QuickJSRunner } from '../src/sandbox/quickjs/quickjs-runner.js';

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

  test('reports a shaping function that returns nothing', async () => {
    assert.match((await sandboxFailure('function shape() {}')).message, /returned nothing/);
  });
});
