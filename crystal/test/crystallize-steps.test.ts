// Crystal from a multi-step handler: SQL and API steps, combined by shape(data, input).
// Crystallized with the app's sources, served by the engine and as a service, and
// verified with and without the sources.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, test } from 'node:test';
import { checkCrystalFolder, crystallize, pinCrystalFolder, verifyCrystalFolder, type CrystallizeOptions } from '../src/index.js';
import { moduleFileFor, readManifest } from '../src/manifest.js';
import { SlimeConfig, createSlime, crystalService, handlerKeyFor, memoryStore, type ApiSchema, type Artifact, type CrystalRegistry, type HandlerRecord, type Source } from '@slime-cloud/core';
import { fakeApiSource, fakeConnector, fakeGenerator, type FakeApiSource } from '@slime-cloud/core/testing';

const REQUEST = { intent: 'accounts on a plan with their open negative feedback', input: { plan: 'Pro' }, output: [{ name: 'string', open: 'integer' }] };
const KEY = handlerKeyFor(REQUEST);
const ROWS = [{ name: 'Acme' }, { name: 'Globex' }];
const EXPECTED = [
  { name: 'Acme', open: 2 },
  { name: 'Globex', open: 0 },
];
const LIQUID: Artifact = {
  version: 2,
  unsatisfiable: null,
  steps: [
    { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts WHERE ($1::text IS NULL OR plan = $1::text)', params: ['plan'] },
    { name: 'feedback', source: 'notion', operation: 'feedback.query', args: [{ param: 'sentiment', input: null, value: 'negative' }] },
  ],
  shapeJs: 'function shape(data) { return data.accounts.map((a) => ({ name: a.name, open: data.feedback.filter((f) => f.account === a.name).length })); }',
  assumptions: [],
};

const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function notion(): FakeApiSource {
  return fakeApiSource({
    name: 'notion',
    operations: {
      'feedback.query': {
        params: [{ name: 'sentiment', type: 'string' }],
        columns: [{ name: 'account', type: 'string', nullable: true }],
        rows: [{ account: 'Acme' }, { account: 'Acme' }],
      },
    },
  });
}

async function appSources(): Promise<{ sources: Record<string, Source>; apiSchemas: Record<string, ApiSchema> }> {
  const api = notion();
  return { sources: { db: fakeConnector({ rows: ROWS }), notion: api }, apiSchemas: { notion: await api.describe({ timeoutMs: 1000, signal: new AbortController().signal }) } };
}

function liquidRecord(artifact: Artifact = LIQUID): HandlerRecord {
  return {
    key: KEY,
    intent: REQUEST.intent,
    output: REQUEST.output,
    artifact,
    paramTypes: { plan: 'string' },
    provenance: { schemaHash: 'schema', dictionaryHash: 'dictionary', promptHash: 'prompt', model: 'model' },
    tier: 'liquid',
    review: 'approved',
    runs: 12,
    fixtures: [{ plan: 'Pro' }, { plan: null }],
    createdAt: '2026-11-21T00:00:00.000Z',
  };
}

async function runJob(options: Partial<CrystallizeOptions> & { record?: HandlerRecord } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'slime-crystal-steps-'));
  dirs.push(dir);
  const store = memoryStore();
  await store.put('handlers', KEY, options.record ?? liquidRecord());
  const { sources, apiSchemas } = await appSources();
  const [report] = await crystallize({ connector: sources['db'] as never, sources, apiSchemas, store, dir, ...options });
  return { dir, report: report! };
}

async function importRegistry(dir: string): Promise<CrystalRegistry> {
  return ((await import(pathToFileURL(join(dir, 'index.mjs')).href)) as { crystals: CrystalRegistry }).crystals;
}

describe('crystallize a multi-step handler', () => {
  test('writes a steps module, unchanged from Liquid, that passes the check', async () => {
    const { dir, report } = await runJob();
    assert.deepEqual([report.outcome, report.isOptimized], ['crystallized', false]);
    assert.deepEqual(await checkCrystalFolder(dir), []);
    const module = await readFile(join(dir, moduleFileFor(KEY)), 'utf8');
    assert.match(module, /export const steps = \[/);
    assert.match(module, /"operation": "feedback\.query"/);
    assert.match(module, /export function shape\(data\)/);
    assert.deepEqual((await readManifest(dir)).entries[KEY]?.sources, ['notion']);
  });

  test('the engine serves it as Crystal, with each step in meta', async () => {
    const { dir } = await runJob();
    const { sources } = await appSources();
    const slime = await createSlime(new SlimeConfig({ sources, store: memoryStore(), generator: fakeGenerator(), crystal: await importRegistry(dir) }));
    try {
      const { data, meta } = await slime.query(REQUEST);
      assert.deepEqual([data, meta.tier], [EXPECTED, 'crystal']);
      assert.deepEqual(meta.steps?.map(({ source }) => source), ['db', 'notion']);
    } finally {
      await slime.close();
    }
  });

  test('its service takes the app\'s sources, and is typed so', async () => {
    const { dir } = await runJob();
    const types = await readFile(join(dir, 'services.d.mts'), 'utf8');
    assert.match(types, /import type \{ Connector, CrystalServiceOptions, Source \} from '@slime-cloud\/core';/);
    assert.match(types, /\(sources: Readonly<Record<string, Source>>, input: \{ "plan"\?: string \| null \}/);
    assert.match(types, /Calls notion: pass the app's sources/);
    const service = crystalService((await importRegistry(dir))[KEY]!);
    assert.deepEqual(await service((await appSources()).sources, { plan: 'Pro' }), EXPECTED);
  });

  test('without the app\'s sources nothing can be compared, so it fails and writes nothing', async () => {
    const { dir, report } = await runJob({ sources: {}, apiSchemas: {} });
    assert.equal(report.outcome, 'failed');
    assert.match(report.reasons.join(), /no recorded input could be compared/);
    assert.deepEqual((await readManifest(dir)).entries, {});
  });

  test('several SQL steps become a steps Crystal too, with no API source to pass', async () => {
    const sqlOnly: Artifact = {
      ...LIQUID,
      steps: [LIQUID.steps[0]!, { name: 'feedback', source: 'db', sql: "SELECT 'Acme' AS account UNION ALL SELECT 'Acme'", params: [] }],
    };
    const { dir, report } = await runJob({ record: liquidRecord(sqlOnly) });
    assert.equal(report.outcome, 'crystallized');
    assert.equal((await readManifest(dir)).entries[KEY]?.sources, undefined);
    assert.match(await readFile(join(dir, 'services.d.mts'), 'utf8'), /\(connector: Connector,/);
  });

  test('an unsatisfiable handler is skipped', async () => {
    const { report } = await runJob({ record: liquidRecord({ ...LIQUID, unsatisfiable: 'no such data', steps: [], shapeJs: null }) });
    assert.deepEqual([report.outcome, report.reasons], ['skipped', ['unsatisfiable: it answers nothing to crystallize']]);
  });
});

describe('verify a steps Crystal', () => {
  const EDITED_SHAPE = 'function shape(data) { const open = new Map(); for (const f of data.feedback) open.set(f.account, (open.get(f.account) ?? 0) + 1); return data.accounts.map((a) => ({ name: a.name, open: open.get(a.name) ?? 0 })); }';

  async function edit(dir: string, shape: string): Promise<void> {
    const file = join(dir, moduleFileFor(KEY));
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(/export function shape[\s\S]*$/, `export ${shape}\n`));
  }

  test('unchanged, it passes without the app\'s sources (the CLI, the merge gate)', async () => {
    const { dir } = await runJob();
    assert.deepEqual(await verifyCrystalFolder(dir, { connector: fakeConnector({ rows: ROWS }) }), []);
  });

  test('edited, it needs the app\'s sources: without them it fails and says where to verify', async () => {
    const { dir } = await runJob();
    await edit(dir, EDITED_SHAPE);
    assert.deepEqual(await pinCrystalFolder(dir), [KEY]);
    const problems = await verifyCrystalFolder(dir, { connector: fakeConnector({ rows: ROWS }) });
    assert.match(problems.join(), /edited and calls notion: verify it where the app's sources are/);
  });

  test('edited and equivalent, it verifies with the app\'s sources', async () => {
    const { dir } = await runJob();
    await edit(dir, EDITED_SHAPE);
    await pinCrystalFolder(dir);
    const { sources, apiSchemas } = await appSources();
    assert.deepEqual(await verifyCrystalFolder(dir, { connector: sources['db'] as never, sources, apiSchemas }), []);
  });

  test('edited to answer differently, it fails with the app\'s sources', async () => {
    const { dir } = await runJob();
    await edit(dir, 'function shape(data) { return data.accounts.map((a) => ({ name: a.name, open: 0 })); }');
    await pinCrystalFolder(dir);
    const { sources, apiSchemas } = await appSources();
    assert.match((await verifyCrystalFolder(dir, { connector: sources['db'] as never, sources, apiSchemas })).join(), /differs from Liquid/);
  });
});
