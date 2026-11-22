// pin and verify: the gate an edited Crystal folder (by a person or an agent) must pass.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { checkCrystalFolder, crystallize, pinCrystalFolder, verifyCrystalFolder } from '../src/index.js';
import { moduleFileFor, readManifest } from '../src/manifest.js';
import { isDatabaseAvailable, READER_URL } from './support/database.js';
import { handlerKeyFor, memoryStore, type Connector, type HandlerRecord } from '@slime-cloud/core';
import { postgresConnector } from '@slime-cloud/core/postgres';
import { artifact, fakeConnector } from '@slime-cloud/core/testing';

const ROWS = [{ name: 'Acme', cents: 1250 }, { name: 'Globex', cents: 99 }];
const REQUEST = { intent: 'accounts in a country with their balance in euros', input: { country: 'DE' }, output: [{ name: 'string', euros: 'number' }] };
const KEY = handlerKeyFor(REQUEST);
const SQL = 'SELECT name, cents FROM accounts WHERE ($1::text IS NULL OR country = $1::text)';
const SHAPE = 'function shape(rows) { return rows.map((r) => ({ name: r.name, euros: r.cents / 100 })); }';
const EXPENSIVE_SQL = 'SELECT name, cents FROM accounts CROSS JOIN invoices WHERE ($1::text IS NULL OR country = $1::text)';

const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** The same rows for any SQL; the plan cost is 10, or 1000 for EXPENSIVE_SQL. */
function connector(): Connector {
  const base = fakeConnector({ rows: ROWS });
  return { ...base, check: async (sql) => ({ cost: sql.includes('CROSS JOIN') ? 1000 : 10, ms: 0 }) };
}

function liquidRecord(): HandlerRecord {
  return {
    key: KEY,
    intent: REQUEST.intent,
    output: REQUEST.output,
    artifact: artifact(SQL, ['country'], SHAPE),
    paramTypes: { country: 'string' },
    provenance: { schemaHash: 'schema', dictionaryHash: 'dictionary', promptHash: 'prompt', model: 'model' },
    tier: 'liquid',
    review: 'approved',
    runs: 12,
    fixtures: [{ country: 'DE' }, { country: null }],
    createdAt: '2026-11-21T00:00:00.000Z',
  };
}

async function crystallized(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slime-verify-test-'));
  dirs.push(dir);
  const store = memoryStore();
  await store.put('handlers', KEY, liquidRecord());
  const [report] = await crystallize({ connector: connector(), store, dir });
  assert.equal(report?.outcome, 'crystallized');
  return dir;
}

async function editModule(dir: string, sql: string, shape: string | null): Promise<void> {
  const shapeExport = shape ? `export ${shape}` : 'export const shape = null;';
  await writeFile(join(dir, moduleFileFor(KEY)), `export const sql = ${JSON.stringify(sql)};\nexport const params = ["country"];\n${shapeExport}\n`);
}

describe('slime-crystal pin and verify', () => {
  test('crystallize pins a cases file with the Liquid code and the recorded inputs', async () => {
    const dir = await crystallized();
    const entry = (await readManifest(dir)).entries[KEY]!;
    const cases = JSON.parse(await readFile(join(dir, entry.cases!), 'utf8'));
    assert.deepEqual(cases.inputs, [{ country: 'DE' }, { country: null }]);
    assert.equal(cases.liquid.steps[0].sql, SQL);
    assert.deepEqual(await verifyCrystalFolder(dir, { connector: connector() }), []);
  });

  test('an equivalent edit is pinned and verifies', async () => {
    const dir = await crystallized();
    await editModule(dir, SQL, 'function shape(rows) { return rows.map(({ name, cents }) => ({ name, euros: cents / 100 })); }');
    assert.match((await checkCrystalFolder(dir)).join(), /does not match the hash/, 'an unpinned edit fails check');
    assert.deepEqual(await pinCrystalFolder(dir), [KEY]);
    assert.equal((await readManifest(dir)).entries[KEY]?.isOptimized, true);
    assert.deepEqual(await verifyCrystalFolder(dir, { connector: connector() }), []);
  });

  test('an edit that changes the answer is pinned but fails verify', async () => {
    const dir = await crystallized();
    await editModule(dir, SQL, 'function shape(rows) { return rows.map((r) => ({ name: r.name, euros: r.cents / 10 })); }');
    await pinCrystalFolder(dir);
    assert.match((await verifyCrystalFolder(dir, { connector: connector() })).join(), /differs from Liquid/);
  });

  test('an equivalent edit that plans costlier than Liquid fails verify', async () => {
    const dir = await crystallized();
    await editModule(dir, EXPENSIVE_SQL, SHAPE);
    await pinCrystalFolder(dir);
    assert.match((await verifyCrystalFolder(dir, { connector: connector() })).join(), /plans at cost 1000, above the Liquid handler's 10/);
  });

  test('a rewritten reference fails check, and pin does not re-pin it', async () => {
    const dir = await crystallized();
    const entry = (await readManifest(dir)).entries[KEY]!;
    await writeFile(join(dir, entry.cases!), JSON.stringify({ liquid: artifact('SELECT 1'), inputs: [] }));
    assert.deepEqual(await pinCrystalFolder(dir), []);
    assert.match((await verifyCrystalFolder(dir, { connector: connector() })).join(), /cases\.json does not match the hash pinned in manifest\.json; only crystallize writes the reference/);
  });

  test('pin refuses a module that fails the allowlist or writes, and pins nothing', async () => {
    const dir = await crystallized();
    const before = await readFile(join(dir, 'manifest.json'), 'utf8');
    await editModule(dir, SQL, 'function shape(rows) { return globalThis; }');
    await assert.rejects(pinCrystalFolder(dir), /globalThis/);
    await editModule(dir, 'DELETE FROM accounts', null);
    await assert.rejects(pinCrystalFolder(dir), /write/);
    assert.equal(await readFile(join(dir, 'manifest.json'), 'utf8'), before);
  });
});

describe('verify against the demo Postgres', { skip: !(await isDatabaseAvailable()) }, () => {
  const LIQUID_SQL = 'SELECT p.name AS plan, a.id FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE ($1::text IS NULL OR a.country = $1::text)';
  const LIQUID_SHAPE =
    'function shape(rows) { const counts = new Map(); for (const row of rows) counts.set(row.plan, (counts.get(row.plan) ?? 0) + 1); return [...counts.entries()].map(([plan, accounts]) => ({ plan, accounts })).sort((a, b) => (a.plan < b.plan ? -1 : 1)); }';
  // What an optimizing agent writes: the grouping moved into SQL, no shape left to run.
  const PURE_SQL = 'SELECT p.name AS plan, count(*)::int AS accounts FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE ($1::text IS NULL OR a.country = $1::text) GROUP BY p.name ORDER BY p.name';
  const COSTLY_SQL = `${PURE_SQL.replace(' GROUP BY', ' AND (SELECT count(*) FROM invoices CROSS JOIN usage_events) >= 0 GROUP BY')}`;
  const PLANS = { intent: 'number of accounts on each plan in a country', input: { country: 'DE' }, output: [{ plan: 'string', accounts: 'integer' }] };
  const PLANS_KEY = handlerKeyFor(PLANS);

  async function realCrystal(db: Connector): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'slime-verify-pg-'));
    dirs.push(dir);
    const store = memoryStore();
    await store.put('handlers', PLANS_KEY, { ...liquidRecord(), key: PLANS_KEY, intent: PLANS.intent, output: PLANS.output, artifact: artifact(LIQUID_SQL, ['country'], LIQUID_SHAPE), fixtures: [{ country: 'DE' }, { country: 'US' }, { country: null }] });
    assert.equal((await crystallize({ connector: db, store, dir }))[0]?.outcome, 'crystallized');
    return dir;
  }

  async function withReader<T>(work: (db: Connector) => Promise<T>): Promise<T> {
    const db = postgresConnector({ url: READER_URL });
    try {
      return await work(db);
    } finally {
      await db.close();
    }
  }

  test('the grouping moved into SQL verifies, with real plans', () =>
    withReader(async (db) => {
      const dir = await realCrystal(db);
      await writeFile(join(dir, moduleFileFor(PLANS_KEY)), `export const sql = ${JSON.stringify(PURE_SQL)};\nexport const params = ["country"];\nexport const shape = null;\n`);
      await pinCrystalFolder(dir);
      assert.deepEqual(await verifyCrystalFolder(dir, { connector: db }), []);
    }));

  test('an equivalent query that plans far costlier fails', () =>
    withReader(async (db) => {
      const dir = await realCrystal(db);
      await writeFile(join(dir, moduleFileFor(PLANS_KEY)), `export const sql = ${JSON.stringify(COSTLY_SQL)};\nexport const params = ["country"];\nexport const shape = null;\n`);
      await pinCrystalFolder(dir);
      assert.match((await verifyCrystalFolder(dir, { connector: db })).join(), /plans at cost [\d.]+, above the Liquid handler's [\d.]+/);
    }));
});
