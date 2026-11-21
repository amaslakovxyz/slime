// M5: the crystallize job, the check, and serving Crystal from the generated index (C10).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { after, describe, test } from 'node:test';
import { SlimeConfig } from '../src/config/slime-config.js';
import { createSlime } from '../src/create-slime.js';
import type { CrystalRegistry } from '../src/engine/crystal/types.js';
import { checkCrystalFolder, crystallize, type CrystallizeOptions } from '../src/crystallize/index.js';
import { moduleFileFor, renderManifest, readManifest } from '../src/crystallize/manifest.js';
import { sha256 } from '../src/shared/hash.js';
import type { HandlerRecord } from '../src/engine/types.js';
import type { OptimizedCode, Optimizer } from '../src/ports.js';
import { requestKey } from '../src/request/key.js';
import { parseRequest } from '../src/request/parse.js';
import { memoryStore } from '../src/stores/memory-store.js';
import type { SlimeStore } from '../src/stores/types.js';
import { artifact, fakeConnector } from './helpers.js';

const ROWS = [
  { name: 'Acme', cents: 1250 },
  { name: 'Globex', cents: 900 },
];
const EUROS = [
  { name: 'Acme', euros: 12.5 },
  { name: 'Globex', euros: 9 },
];
const REQUEST = { intent: 'accounts in a country with their balance in euros', input: { country: 'DE' }, output: [{ name: 'string', euros: 'number' }] };
const KEY = requestKey(parseRequest(REQUEST));
const SQL = 'SELECT name, cents FROM accounts WHERE ($1::text IS NULL OR country = $1::text)';
const LIQUID_SHAPE = 'function shape(rows) { return rows.map((r) => ({ name: r.name, euros: r.cents / 100 })); }';
const BIN = new URL('../src/crystallize/bin.ts', import.meta.url).pathname;
const runFile = promisify(execFile);

const temporaryDirs: string[] = [];
after(() => Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function crystalDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slime-crystal-test-'));
  temporaryDirs.push(dir);
  return dir;
}

function liquidRecord(overrides: Partial<HandlerRecord> = {}): HandlerRecord {
  return {
    key: KEY,
    intent: REQUEST.intent,
    output: REQUEST.output,
    artifact: artifact(SQL, ['country'], LIQUID_SHAPE),
    paramTypes: { country: 'string' },
    provenance: { schemaHash: 'schema', dictionaryHash: 'dictionary', promptHash: 'prompt', model: 'model' },
    tier: 'liquid',
    review: 'approved',
    runs: 12,
    fixtures: [{ country: 'DE' }, { country: null }],
    createdAt: '2026-11-21T00:00:00.000Z',
    ...overrides,
  };
}

async function storeWith(record: HandlerRecord): Promise<SlimeStore> {
  const store = memoryStore();
  await store.put('handlers', record.key, record);
  return store;
}

async function runJob(record: HandlerRecord, options: Partial<CrystallizeOptions> = {}) {
  const dir = options.dir ?? (await crystalDir());
  const reports = await crystallize({ connector: fakeConnector({ rows: ROWS }), store: await storeWith(record), dir, ...options });
  return { dir, report: reports[0]! };
}

function optimizerReturning(code: OptimizedCode): Optimizer {
  return { model: 'stub-optimizer', optimize: async () => ({ code, ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 }) };
}

async function importRegistry(dir: string): Promise<CrystalRegistry> {
  return ((await import(pathToFileURL(join(dir, 'index.mjs')).href)) as { crystals: CrystalRegistry }).crystals;
}

describe('crystallize (M5)', () => {
  test('crystallizes a ready Liquid handler; the folder passes the check; locked mode serves it as Crystal', async () => {
    const { dir, report } = await runJob(liquidRecord());
    assert.deepEqual([report.outcome, report.isOptimized], ['crystallized', false]);
    assert.deepEqual(await checkCrystalFolder(dir), []);

    const connector = fakeConnector({ rows: ROWS });
    const slime = await createSlime(new SlimeConfig({ connector, store: memoryStore(), crystal: await importRegistry(dir) }));
    try {
      const { data, meta } = await slime.query(REQUEST);
      assert.deepEqual(data, EUROS);
      assert.deepEqual([meta.tier, meta.cache, meta.review, meta.sql], ['crystal', 'hit', 'approved', undefined]);
    } finally {
      await slime.close();
    }
  });

  test('skips handlers that are not ready, and ones already crystallized', async () => {
    assert.match((await runJob(liquidRecord({ runs: 3 }))).report.reasons[0]!, /3 of 10 successful runs/);
    assert.match((await runJob(liquidRecord({ review: 'rejected' }))).report.reasons[0]!, /review is rejected/);
    assert.match((await runJob(liquidRecord({ tier: 'gas' }))).report.reasons[0]!, /tier is gas/);
    const { dir } = await runJob(liquidRecord());
    assert.equal((await runJob(liquidRecord(), { dir })).report.outcome, 'already');
  });

  test('uses an optimized version that gives the same output, and records its notes', async () => {
    const shape = 'function shape(rows) { return rows.map(({ name, cents }) => ({ name, euros: cents / 100 })); }';
    const optimizer = optimizerReturning({ sql: SQL, params: ['country'], shape, notes: ['destructured the row'] });
    const { dir, report } = await runJob(liquidRecord(), { optimizer });
    assert.deepEqual([report.outcome, report.isOptimized], ['crystallized', true]);
    assert.deepEqual((await readManifest(dir)).entries[KEY]?.notes, ['destructured the row']);
  });

  test('falls back to the unchanged Liquid code when the optimized version differs or breaks the allowlist', async () => {
    const differs = optimizerReturning({ sql: SQL, params: ['country'], shape: 'function shape(rows) { return rows.map((r) => ({ name: r.name, euros: r.cents })); }', notes: [] });
    const unsafe = optimizerReturning({ sql: SQL, params: ['country'], shape: 'function shape(rows) { while (true) {} }', notes: [] });
    for (const [optimizer, reason] of [[differs, /differs from Liquid/], [unsafe, /while/]] as const) {
      const { report } = await runJob(liquidRecord(), { optimizer });
      assert.deepEqual([report.outcome, report.isOptimized], ['crystallized', false]);
      assert.match(report.reasons.join(' '), reason);
    }
  });

  test('fails a handler whose Liquid code breaks the allowlist, and writes nothing', async () => {
    const { dir, report } = await runJob(liquidRecord({ artifact: artifact(SQL, ['country'], 'function shape(rows) { return globalThis; }') }));
    assert.equal(report.outcome, 'failed');
    assert.match(report.reasons.join(' '), /globalThis/);
    assert.deepEqual(await checkCrystalFolder(dir), []);
  });
});

describe('slime-crystal check (M5)', () => {
  test('refuses a hand-edited module, even when its hash is re-pinned', async () => {
    const { dir } = await runJob(liquidRecord());
    const modulePath = join(dir, moduleFileFor(KEY));
    const edited = (await readFile(modulePath, 'utf8')).replace('r.cents / 100', 'r.cents / 100 + Number(globalThis.x)');
    await writeFile(modulePath, edited);
    assert.match((await checkCrystalFolder(dir)).join(' '), /does not match the hash pinned/);

    const manifest = await readManifest(dir);
    manifest.entries[KEY]!.sha256 = sha256(edited);
    await writeFile(join(dir, 'manifest.json'), renderManifest(manifest));
    assert.match((await checkCrystalFolder(dir)).join(' '), /globalThis/);
  });

  test('refuses an edited index and a module missing from the manifest', async () => {
    const { dir } = await runJob(liquidRecord());
    await writeFile(join(dir, 'index.mjs'), '// edited\n', { flag: 'a' });
    await writeFile(join(dir, 'extra.mjs'), 'export const sql = "SELECT 1";\n');
    const problems = (await checkCrystalFolder(dir)).join(' ');
    assert.match(problems, /index\.mjs does not match manifest\.json/);
    assert.match(problems, /extra\.mjs is not in manifest\.json/);
  });

  test('the bin exits 0 on a clean folder and 1 on a broken one', async () => {
    const { dir } = await runJob(liquidRecord());
    const check = () => runFile(process.execPath, ['--import', 'tsx', BIN, 'check', dir]);
    assert.match((await check()).stdout, /Crystal check passed/);
    await writeFile(join(dir, moduleFileFor(KEY)), '// edited\n', { flag: 'a' });
    await assert.rejects(check(), (error: { code?: number }) => error.code === 1);
  });
});
