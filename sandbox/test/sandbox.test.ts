// The QuickJS worker that runs generated shaping code.
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SlimeError } from '../src/errors.js';
import { runShape, warmSandbox } from '../src/sandbox.js';

const fails = async (shapeJs: string) => {
  const started = performance.now();
  const err = await runShape(shapeJs, [], {}).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof SlimeError, 'expected a SlimeError');
  assert.equal(err.code, 'SANDBOX_ERROR');
  return { message: err.message, ms: performance.now() - started };
};

describe('shaping sandbox', () => {
  test('runs a shaping function on rows and input', async () => {
    await warmSandbox();
    const r = await runShape('function shape(rows, input) { return rows.map(r => r.n * input.k) }', [{ n: 1 }, { n: 2 }], { k: 10 });
    assert.deepEqual(r.data, [10, 20]);
  });

  test('has no access to the host process, modules or network', async () => {
    assert.match((await fails('function shape() { return process.env }')).message, /process/);
    assert.match((await fails('function shape() { return require("fs") }')).message, /require/);
    assert.match((await fails('function shape() { return fetch("http://x") }')).message, /fetch/);
  });

  test('interrupts an infinite loop at the time limit', async () => {
    const { ms } = await fails('function shape() { while (true) {} }');
    assert.ok(ms < 1_000, `took ${ms} ms`);
  });

  // A long native call can't be interrupted from inside QuickJS; the worker is killed.
  test('kills a worker stuck in a long native call', async () => {
    const { ms } = await fails('function shape() { const a = []; while (true) a.push("x".repeat(1e6)) }');
    assert.ok(ms < 1_500, `took ${ms} ms`);
  });

  test('keeps working after a worker was killed, including in parallel', async () => {
    await fails('function shape() { const a = []; while (true) a.push("x".repeat(1e6)) }');
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => runShape('function shape(r, i) { return i.n * 2 }', [], { n })),
    );
    assert.deepEqual(results.map((r) => r.data), [2, 4, 6, 8, 10]);
  });

  test('reports a shaping function that returns nothing', async () => {
    assert.match((await fails('function shape() {}')).message, /returned nothing/);
  });
});
