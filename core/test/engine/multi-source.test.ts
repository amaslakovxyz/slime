// Multi-source handlers through the whole engine: promotion, review, final source
// errors, repair, Crystal, and one run against the demo database (P2.10).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { SlimeConfig, type SlimeOptions } from '../../src/config/slime-config.js';
import { postgresConnector } from '../../src/connectors/postgres/index.js';
import { createSlime } from '../../src/create-slime.js';
import { changedProvenance } from '../../src/request/key.js';
import { crystallize } from '../../src/crystallize/index.js';
import type { Slime } from '../../src/engine/types.js';
import type { ArtifactV2, SqlStep } from '../../src/models/artifact-v2.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import type { SlimeStore } from '../../src/stores/types.js';
import type { Source } from '../../src/sources/types.js';
import { fakeApiSource, type FakeOperation } from '../../src/testing/fake-api-source.js';
import { fakeConnector, stubGenerator, stubReviewer } from '../../src/testing/fakes.js';
import { READER_URL, isDatabaseAvailable } from '../support/database.js';

const ACCOUNTS: SqlStep = { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts', params: [] };
const COMBINED: ArtifactV2 = {
  version: 2,
  unsatisfiable: null,
  steps: [ACCOUNTS, { name: 'feedback', source: 'notion', operation: 'feedback.query', args: [{ param: 'sentiment', input: null, value: 'negative' }] }],
  shapeJs: 'function shape(data) { return data.accounts.map((a) => ({ name: a.name, open: data.feedback.filter((f) => f.account === a.name).length })); }',
  assumptions: [],
};
const REQUEST = { intent: 'accounts with open negative feedback', output: [{ name: 'string', open: 'integer' }] };
const ROWS = [{ name: 'Acme' }, { name: 'Globex' }];

function feedback(overrides: Partial<FakeOperation> = {}): FakeOperation {
  return {
    params: [{ name: 'sentiment', type: 'string', values: ['negative', 'positive'] }],
    columns: [{ name: 'account', type: 'string', nullable: true }],
    rows: [{ account: 'Acme' }],
    ...overrides,
  };
}

const instances: Slime[] = [];
after(() => Promise.all(instances.map((slime) => slime.close())));

async function start(options: Record<string, unknown> & { sources?: Record<string, Source>; store?: SlimeStore }): Promise<Slime> {
  const sources = options.sources ?? { db: fakeConnector({ rows: ROWS }), notion: fakeApiSource({ operations: { 'feedback.query': feedback() } }) };
  const config = new SlimeConfig({ store: memoryStore(), ...options, sources } as unknown as SlimeOptions);
  const slime = await createSlime(config);
  instances.push(slime);
  return slime;
}

describe('multi-source handlers in the engine', () => {
  test('a combined handler is promoted to liquid after enough runs', async () => {
    const slime = await start({ generator: stubGenerator(() => COMBINED) });
    for (let run = 0; run < 3; run++) assert.deepEqual((await slime.query(REQUEST)).data, [{ name: 'Acme', open: 1 }, { name: 'Globex', open: 0 }]);
    await slime.flush();
    assert.deepEqual(slime.stats().handlers, { gas: 0, liquid: 1 });
  });

  test('with a reviewer, it is promoted after an approving review', async () => {
    const reviewer = stubReviewer(['approve']);
    const slime = await start({ generator: stubGenerator(() => COMBINED), reviewer, tiers: { gasToLiquidRuns: 1 } });
    await slime.query(REQUEST);
    await slime.flush();
    assert.equal(reviewer.calls, 1);
    assert.deepEqual(slime.stats().handlers, { gas: 0, liquid: 1 });
  });

  test('a source failure during generation is final: no repair attempt', async () => {
    const generator = stubGenerator(() => COMBINED);
    const notion = fakeApiSource({ operations: { 'feedback.query': feedback({ failWith: { status: 503, message: 'down' } }) } });
    const slime = await start({ generator, sources: { db: fakeConnector({ rows: ROWS }), notion } });
    await assert.rejects(slime.query(REQUEST), { code: 'SOURCE_ERROR', retryable: true });
    assert.equal(generator.calls, 1);
  });

  test('QUERY_TOO_LARGE during generation is repaired with a narrower handler', async () => {
    const narrowed: ArtifactV2 = { ...COMBINED, steps: [ACCOUNTS] , shapeJs: 'function shape(data) { return data.accounts.map((a) => ({ name: a.name, open: 0 })); }' };
    const generator = stubGenerator((request) => (request.previous ? narrowed : COMBINED));
    const many = Array.from({ length: 5 }, () => ({ account: 'Acme' }));
    const notion = fakeApiSource({ operations: { 'feedback.query': feedback({ rows: many }) } });
    const slime = await start({ generator, sources: { db: fakeConnector({ rows: ROWS }), notion }, limits: { rowCap: 3 } });
    assert.deepEqual((await slime.query(REQUEST)).data, [{ name: 'Acme', open: 0 }, { name: 'Globex', open: 0 }]);
    assert.equal(generator.calls, 2);
  });

  describe('Crystal (MS9)', () => {
    const dirs: string[] = [];
    after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

    // With main's provenance check (M.2): the job compares against the instance's current provenance.
    async function crystalOutcome(artifact: ArtifactV2): Promise<string | undefined> {
      const store = memoryStore();
      const slime = await start({ generator: stubGenerator(() => artifact), store, tiers: { gasToLiquidRuns: 1 } });
      await slime.query(REQUEST);
      await slime.flush();
      const dir = await mkdtemp(join(tmpdir(), 'slime-crystal-'));
      dirs.push(dir);
      const [report] = await crystallize({ connector: fakeConnector({ rows: ROWS }), store, dir, minRuns: 1, isDryRun: true, provenance: slime.provenance() });
      return report?.outcome;
    }

    test('a single-SQL-step handler, stored as v1, crystallizes', async () => {
      const singleSql: ArtifactV2 = { ...COMBINED, steps: [ACCOUNTS], shapeJs: 'function shape(data) { return data.accounts.map((a) => ({ name: a.name, open: 0 })); }' };
      assert.equal(await crystalOutcome(singleSql), 'crystallized');
    });

    test('a handler with an API step is skipped', async () => {
      assert.equal(await crystalOutcome(COMBINED), 'skipped');
    });
  });

  test('provenance() carries the multi-source prompt hash and per-source hashes (M.2)', async () => {
    const slime = await start({ generator: stubGenerator(() => COMBINED) });
    const provenance = slime.provenance();
    assert.equal(provenance.promptHash, 'stub-multi-source-prompt');
    assert.deepEqual(Object.keys(provenance.sourceHashes ?? {}), ['db', 'notion']);
    assert.deepEqual(changedProvenance({ ...provenance, sourceHashes: { db: 'other' } }, provenance), [], 'sourceHashes alone never make a handler stale');
  });

  test('against the demo database: SQL step on Postgres, API step on a fake source', async (context) => {
    if (!(await isDatabaseAvailable())) return context.skip('Postgres is not running');
    const plans: SqlStep = { name: 'plans', source: 'db', sql: 'SELECT p.name, count(a.id)::int AS "accounts" FROM plans p JOIN accounts a ON a.plan_id = p.id GROUP BY p.name ORDER BY p.name', params: [] };
    const artifact: ArtifactV2 = {
      ...COMBINED,
      steps: [plans, COMBINED.steps[1]!],
      shapeJs: 'function shape(data) { return data.plans.map((p) => ({ plan: p.name, accounts: p.accounts, notes: data.feedback.length })); }',
    };
    const db = postgresConnector({ url: READER_URL });
    const slime = await start({ generator: stubGenerator(() => artifact), sources: { db, notion: fakeApiSource({ operations: { 'feedback.query': feedback() } }) } });
    const { data } = await slime.query({ intent: 'plans with account counts and feedback notes', output: [{ plan: 'string', accounts: 'integer', notes: 'integer' }] });
    assert.ok(Array.isArray(data) && data.length > 0);
    for (const row of data as { accounts: number; notes: number }[]) assert.ok(row.accounts > 0 && row.notes === 1);
  });
});
