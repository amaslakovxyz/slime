// The crystallize job against a real engine: a sandbox the host shares, and which
// multi-source handlers can become Crystal (MS9).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { QuickJSRunner, SlimeConfig, createSlime, handlerKeyFor, memoryStore, type Artifact, type SandboxRunner, type Slime, type SlimeOptions, type SqlStep } from '@slime-cloud/core';
import { artifact, fakeApiSource, fakeConnector, stubGenerator } from '@slime-cloud/core/testing';
import { crystallize } from '../src/crystallize.js';
import { readManifest } from '../src/manifest.js';

const dirs: string[] = [];
const instances: Slime[] = [];
after(async () => {
  await Promise.all(instances.map((slime) => slime.close()));
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function crystalDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slime-crystal-engine-'));
  dirs.push(dir);
  return dir;
}

describe('a sandbox the host shares', () => {
  const ROWS = [{ name: 'Acme', cents: 1250 }, { name: 'Globex', cents: 900 }];
  const REQUEST = { intent: 'accounts with their balance in euros', input: { country: 'DE' }, output: [{ name: 'string', euros: 'number' }] };
  const KEY = handlerKeyFor(REQUEST);
  const SQL = 'SELECT name, cents FROM accounts WHERE country = $1::text';
  const SHAPE_SOURCE = 'function shape(rows) { return rows.map((r) => ({ name: r.name, euros: r.cents / 100 })); }';

  test('crystallize() uses it, leaves it running, and its equivalence test accepts a string-shape candidate', async () => {
    const dir = await crystalDir();
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

describe('multi-source handlers and Crystal (MS9)', () => {
  const ACCOUNTS: SqlStep = { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts', params: [] };
  const COMBINED: Artifact = {
    version: 2,
    unsatisfiable: null,
    steps: [ACCOUNTS, { name: 'feedback', source: 'notion', operation: 'feedback.query', args: [{ param: 'sentiment', input: null, value: 'negative' }] }],
    shapeJs: 'function shape(data) { return data.accounts.map((a) => ({ name: a.name, open: data.feedback.filter((f) => f.account === a.name).length })); }',
    assumptions: [],
  };
  const REQUEST = { intent: 'accounts with open negative feedback', output: [{ name: 'string', open: 'integer' }] };
  const ROWS = [{ name: 'Acme' }, { name: 'Globex' }];
  const notion = () =>
    fakeApiSource({
      operations: {
        'feedback.query': { params: [{ name: 'sentiment', type: 'string', values: ['negative', 'positive'] }], columns: [{ name: 'account', type: 'string', nullable: true }], rows: [{ account: 'Acme' }] },
      },
    });

  // The job compares against the instance's current provenance (M.2).
  async function crystalOutcome(handler: Artifact): Promise<string | undefined> {
    const store = memoryStore();
    const config = new SlimeConfig({ sources: { db: fakeConnector({ rows: ROWS }), notion: notion() }, store, generator: stubGenerator(() => handler), tiers: { gasToLiquidRuns: 1 } } as unknown as SlimeOptions);
    const slime = await createSlime(config);
    instances.push(slime);
    await slime.query(REQUEST);
    await slime.flush();
    const [report] = await crystallize({ connector: fakeConnector({ rows: ROWS }), store, dir: await crystalDir(), minRuns: 1, isDryRun: true, provenance: slime.provenance() });
    return report?.outcome;
  }

  test('a single-SQL-step handler crystallizes', async () => {
    const singleSql: Artifact = { ...COMBINED, steps: [ACCOUNTS], shapeJs: 'function shape(data) { return data.accounts.map((a) => ({ name: a.name, open: 0 })); }' };
    assert.equal(await crystalOutcome(singleSql), 'crystallized');
  });

  test('a handler with an API step is skipped', async () => {
    assert.equal(await crystalOutcome(COMBINED), 'skipped');
  });
});
