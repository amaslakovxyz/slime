// Crystal end to end: crystallize proven Liquid handlers into a folder, then
// serve them from that folder with no sandbox worker.
import './setup.js';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { config } from '../src/config.js';
import { PostgresConnector } from '../src/connectors/postgres.js';
import { crystallize } from '../src/crystal/crystallize.js';
import { readManifest, sha256Hex } from '../src/crystal/loader.js';
import type { CrystalCode } from '../src/crystal/module.js';
import type { Optimizer, OptimizeRequest } from '../src/crystal/optimizers.js';
import type { Engine } from '../src/engine.js';
import { schemaHashOf } from '../src/fingerprint.js';
import { promptHashFor } from '../src/prompts.js';
import { MemoryHandlerStore } from '../src/store.js';
import { DB_URL, StubGenerator, TOP_ACCOUNTS, artifact, closeEngines, dbAvailable, makeEngine, withConfig } from './helpers.js';

const hasDb = await dbAvailable();

const NESTED = {
  intent: 'plans that have accounts in a given country, each with the list of those account names',
  output: [{ plan: 'string', accounts: [{ name: 'string' }] }],
  artifact: artifact(
    'SELECT p.name AS plan, a.name FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE a.country = $1::text ORDER BY p.name, a.name',
    ['country'],
    `function shape(rows) {
  const byPlan = new Map();
  for (const r of rows) {
    if (!byPlan.has(r.plan)) byPlan.set(r.plan, []);
    byPlan.get(r.plan).push({ name: r.name });
  }
  return [...byPlan].map(([plan, accounts]) => ({ plan, accounts }));
}`,
  ),
};

class StubOptimizer implements Optimizer {
  readonly model = 'stub';
  calls: OptimizeRequest[] = [];
  constructor(private readonly rewrite: (req: OptimizeRequest) => CrystalCode) {}
  async optimize(req: OptimizeRequest) {
    this.calls.push(req);
    return { ...this.rewrite(req), notes: ['stub rewrite'] };
  }
}

const dirs: string[] = [];
const newDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'slime-crystal-test-'));
  dirs.push(d);
  return d;
};

/** Runs `inputs` through a fresh engine so the handler is Liquid (with recorded runs) in `store`. */
async function makeLiquid(store: MemoryHandlerStore, spec: { intent: string; output: unknown; artifact: CrystalCode | any }, inputs: Record<string, unknown>[]) {
  const engine = await makeEngine({ generator: new StubGenerator([spec.artifact]), store });
  const req = (input: Record<string, unknown>) => engine.query({ intent: spec.intent, input, output: spec.output });
  await req(inputs[0]);
  await engine.reviewsSettled();
  let last;
  for (const input of inputs.slice(1)) last = await req(input);
  assert.equal(last?.meta.tier, 'liquid');
  await engine.flush();
}

async function runCrystallize(store: MemoryHandlerStore, dir: string, optimizer: Optimizer | null, minRuns = 3) {
  const connector = new PostgresConnector(DB_URL);
  try {
    const schemaHash = schemaHashOf(await connector.describe());
    return await crystallize({
      connector,
      store,
      dir,
      schemaHash,
      scope: { schemaHash, promptHash: promptHashFor(config.provider), model: config.model },
      minRuns,
      optimizer,
    });
  } finally {
    await connector.close();
  }
}

const ask = (engine: Engine, spec: { intent: string; output: unknown }, input: Record<string, unknown>) =>
  engine.query({ intent: spec.intent, input, output: spec.output });

describe('crystallize', { skip: !hasDb }, () => {
  afterEach(async () => {
    await closeEngines();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('moves a proven Liquid handler into the folder, and the server then serves it as Crystal', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      const store = new MemoryHandlerStore();
      await makeLiquid(store, TOP_ACCOUNTS, [{ limit: 5 }, { limit: 10 }, { limit: 3 }]);
      const dir = newDir();

      const [report] = await runCrystallize(store, dir, null);
      assert.equal(report.outcome, 'crystallized');
      assert.equal(report.optimized, false);

      const manifest = readManifest(dir);
      const entry = manifest.entries[report.key];
      assert.equal(sha256Hex(readFileSync(join(dir, entry.file), 'utf8')), entry.sha256);
      assert.ok(existsSync(join(dir, entry.fixtures)));

      const generator = new StubGenerator([() => assert.fail('Crystal must not generate')]);
      const engine = await makeEngine({ generator, crystalDir: dir });
      const r = await ask(engine, TOP_ACCOUNTS, { limit: 7 });
      assert.equal(r.meta.tier, 'crystal');
      assert.equal((r.data as unknown[]).length, 7);
      assert.equal(generator.calls, 0);
    });
  });

  test('the optimizer sees code only, never the request text', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      const store = new MemoryHandlerStore();
      await makeLiquid(store, TOP_ACCOUNTS, [{ limit: 5 }, { limit: 10 }, { limit: 3 }]);
      const optimizer = new StubOptimizer((req) => ({ sql: req.sql, params: req.params, shape: req.shapeJs }));
      await runCrystallize(store, newDir(), optimizer);
      assert.ok(!JSON.stringify(optimizer.calls[0]).includes('top N accounts'));
    });
  });

  test('an optimization that changes results is caught, and the unchanged code is used instead', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      const store = new MemoryHandlerStore();
      await makeLiquid(store, TOP_ACCOUNTS, [{ limit: 5 }, { limit: 10 }, { limit: 3 }]);
      const wrong = new StubOptimizer((req) => ({ sql: req.sql.replace('DESC', 'ASC'), params: req.params, shape: null }));
      const [report] = await runCrystallize(store, newDir(), wrong);
      assert.equal(report.outcome, 'crystallized');
      assert.equal(report.optimized, false);
      assert.ok(report.reasons.some((r) => r.startsWith('optimized version: differs from Liquid')));
    });
  });

  test('an equivalent optimization is accepted and serves nested output', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      const store = new MemoryHandlerStore();
      await makeLiquid(store, NESTED, [{ country: 'DE' }, { country: 'FR' }, { country: 'NL' }]);
      const rewrite = new StubOptimizer((req) => ({
        sql: req.sql,
        params: req.params,
        shape: `function shape(rows) {
  const groups = new Map();
  rows.forEach((r) => {
    const list = groups.get(r.plan) ?? [];
    list.push({ name: r.name });
    groups.set(r.plan, list);
  });
  return Array.from(groups.entries(), ([plan, accounts]) => ({ plan, accounts }));
}`,
      }));
      const dir = newDir();
      const [report] = await runCrystallize(store, dir, rewrite);
      assert.equal(report.outcome, 'crystallized');
      assert.equal(report.optimized, true);

      const engine = await makeEngine({ crystalDir: dir });
      const r = await ask(engine, NESTED, { country: 'ES' });
      assert.equal(r.meta.tier, 'crystal');
      assert.ok((r.data as { accounts: unknown[] }[]).every((p) => p.accounts.length > 0));
    });
  });

  test('Liquid code outside the Crystal allowlist stays Liquid', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      const loopy = { ...TOP_ACCOUNTS, artifact: artifact(TOP_ACCOUNTS.artifact.sql, ['limit'], 'function shape(rows) { const out = []; for (let i = 0; i < rows.length; i++) out.push(rows[i]); return out; }') };
      const store = new MemoryHandlerStore();
      await makeLiquid(store, loopy, [{ limit: 5 }, { limit: 10 }, { limit: 3 }]);
      const dir = newDir();
      const [report] = await runCrystallize(store, dir, null);
      assert.equal(report.outcome, 'failed');
      assert.match(report.reasons.join(' '), /for\(;;\)/);
      assert.ok(!existsSync(join(dir, 'manifest.json')), 'nothing is written');
    });
  });

  test('skips handlers without enough runs, and ones already crystallized', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      const store = new MemoryHandlerStore();
      await makeLiquid(store, TOP_ACCOUNTS, [{ limit: 5 }, { limit: 10 }, { limit: 3 }]);
      const dir = newDir();
      const [early] = await runCrystallize(store, dir, null, 100);
      assert.equal(early.outcome, 'not-ready');
      assert.match(early.reasons[0], /3 of 100/);
      await runCrystallize(store, dir, null);
      const [again] = await runCrystallize(store, dir, null);
      assert.equal(again.outcome, 'already');
    });
  });
});

describe('loading the Crystal folder', { skip: !hasDb }, () => {
  afterEach(async () => {
    await closeEngines();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function crystalFolder() {
    const store = new MemoryHandlerStore();
    await makeLiquid(store, TOP_ACCOUNTS, [{ limit: 5 }, { limit: 10 }, { limit: 3 }]);
    const dir = newDir();
    const [report] = await runCrystallize(store, dir, null);
    const entry = readManifest(dir).entries[report.key];
    return { dir, key: report.key, file: join(dir, entry.file) };
  }

  test('refuses a module edited after it was pinned', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      const { dir, file } = await crystalFolder();
      writeFileSync(file, readFileSync(file, 'utf8').replace('DESC', 'ASC'));
      const engine = await makeEngine({ crystalDir: dir });
      assert.equal(engine.stats().crystal.loaded, 0);
      assert.match(engine.stats().crystal.refused[0].reason, /does not match the hash/);
    });
  });

  test('refuses a module that re-pins its hash but breaks the allowlist', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      const { dir, key, file } = await crystalFolder();
      const evil = readFileSync(file, 'utf8').replace('export const shape = null;', 'export function shape(rows) { return process.env; }');
      writeFileSync(file, evil);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      manifest.entries[key].sha256 = sha256Hex(evil);
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
      const engine = await makeEngine({ crystalDir: dir });
      assert.equal(engine.stats().crystal.loaded, 0);
      assert.match(engine.stats().crystal.refused[0].reason, /process/);
    });
  });

  test('SLIME_CRYSTAL=off ignores the folder', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      const { dir } = await crystalFolder();
      await withConfig({ crystal: false }, async () => {
        const engine = await makeEngine({ generator: new StubGenerator([TOP_ACCOUNTS.artifact]), crystalDir: dir });
        assert.equal(engine.stats().crystal.loaded, 0);
        assert.equal((await ask(engine, TOP_ACCOUNTS, { limit: 5 })).meta.tier, 'gas');
      });
    });
  });

  test('ignores Crystal built against another schema', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      const { dir, key } = await crystalFolder();
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      manifest.entries[key].schemaHash = 'other-schema';
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
      const engine = await makeEngine({ crystalDir: dir });
      assert.equal(engine.stats().crystal.loaded, 0);
      assert.equal(engine.stats().crystal.otherSchema, 1);
    });
  });
});

describe("the repo's own Crystal folder", () => {
  // Runs in CI: every committed Crystal must still match its pinned hash and pass the allowlist.
  test('every entry matches its hash and passes the allowlist', async () => {
    const manifest = readManifest(config.crystalDir);
    const { importModuleText } = await import('../src/crystal/loader.js');
    for (const [key, entry] of Object.entries(manifest.entries)) {
      const text = readFileSync(join(config.crystalDir, entry.file), 'utf8');
      assert.equal(sha256Hex(text), entry.sha256, `${key}: hash`);
      await importModuleText(text);
      assert.ok(existsSync(join(config.crystalDir, entry.fixtures)), `${key}: recorded runs file`);
    }
  });
});
