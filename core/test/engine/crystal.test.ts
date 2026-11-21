// Crystal handlers whose shape is source text (hosts that load modules as data) and
// the sandbox runner a host shares across engines.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { SlimeConfig } from '../../src/config/slime-config.js';
import { createSlime } from '../../src/create-slime.js';
import type { CrystalHandler, CrystalRegistry } from '../../src/engine/crystal/types.js';
import { crystallize } from '../../src/crystallize/index.js';
import { readManifest } from '../../src/crystallize/manifest.js';
import { requestKey } from '../../src/request/key.js';
import { parseRequest } from '../../src/request/parse.js';
import { QuickJSRunner } from '../../src/sandbox/quickjs/quickjs-runner.js';
import type { SandboxRunner } from '../../src/sandbox/types.js';
import { SlimeError } from '../../src/shared/errors.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import { artifact, fakeConnector } from '../../src/testing/fakes.js';

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

const temporaryDirs: string[] = [];
after(() => Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function crystalWith(shape: CrystalHandler['shape']): CrystalRegistry {
  return {
    [KEY]: { sql: SQL, params: ['country'], shape, intent: REQUEST.intent, output: REQUEST.output, paramTypes: { country: 'string' }, schemaHash: 'schema', review: 'approved' },
  };
}

async function slimeWith(crystal: CrystalRegistry, runner?: SandboxRunner) {
  const config = new SlimeConfig({ connector: fakeConnector({ rows: ROWS }), store: memoryStore(), crystal, limits: { shapeTimeoutMs: SHAPE_TIMEOUT_MS } });
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

  test('crystallize() uses it, leaves it running, and its equivalence test accepts a string-shape candidate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slime-crystal-runner-'));
    temporaryDirs.push(dir);
    const store = memoryStore();
    await store.put('handlers', KEY, {
      key: KEY,
      intent: REQUEST.intent,
      output: REQUEST.output,
      artifact: artifact(SQL, ['country'], SHAPE_SOURCE),
      paramTypes: { country: 'string' },
      provenance: { schemaHash: 'schema', dictionaryHash: 'dictionary', promptHash: 'prompt', model: 'model' },
      tier: 'liquid',
      review: 'approved',
      runs: 12,
      fixtures: [{ country: 'DE' }],
      createdAt: '2026-11-21T00:00:00.000Z',
    });
    let shapeRuns = 0;
    const shared = new QuickJSRunner();
    const counting: SandboxRunner = {
      run: (job, limits) => {
        shapeRuns++;
        return shared.run(job, limits);
      },
      close: () => shared.close(),
    };
    try {
      const [report] = await crystallize({ connector: fakeConnector({ rows: ROWS }), store, dir, runner: counting });
      assert.equal(report?.outcome, 'crystallized');
      assert.ok((await readManifest(dir)).entries[KEY]);
      // Liquid and the candidate both ran in the sandbox, once per recorded input.
      assert.equal(shapeRuns, 2);
      assert.equal(await shared.run({ code: 'function shape() { return 1; }', rows: [], input: {} }, { timeoutMs: 500, memoryBytes: 16 * 1024 * 1024 }), 1);
    } finally {
      await shared.close();
    }
  });
});
