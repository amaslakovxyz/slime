// The Postgres connector against the demo database, as the read-only slime_reader (M3).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SlimeConfig } from '../src/config/slime-config.js';
import { createSlime } from '../src/create-slime.js';
import { SlimeError } from '../src/shared/errors.js';
import { offlineGenerator } from '../src/models/offline/index.js';
import type { Connector, QueryLimits } from '../src/ports.js';
import { valuesInCheck } from '../src/connectors/postgres/enum-values.js';
import { postgresConnector } from '../src/connectors/postgres/index.js';
import { memoryStore } from '../src/stores/memory-store.js';
import { READER_URL, WRITER_URL, asWriter, isDatabaseAvailable } from './database.js';
import { artifact } from './helpers.js';

const hasDatabase = await isDatabaseAvailable();
const LIMITS: QueryLimits = { timeoutMs: 2_000, rowCap: 1_000 };
// A table and an enum type slime_writer creates in its own schema, for the tests below.
const WRITER_FIXTURE = `
  DROP TABLE IF EXISTS slime_meta.probe;
  DROP TYPE IF EXISTS slime_meta.tier;
  CREATE TYPE slime_meta.tier AS ENUM ('gas', 'liquid', 'crystal');
  CREATE TABLE slime_meta.probe (id int PRIMARY KEY, tier slime_meta.tier NOT NULL);`;

const errorCode = (pending: Promise<unknown>): Promise<string> =>
  pending.then(
    () => 'OK',
    (error: unknown) => (error instanceof SlimeError ? error.code : `not a SlimeError: ${String(error)}`),
  );

describe('enum values in CHECK constraints (D1)', () => {
  test('reads the values Postgres stores for status IN (…)', () => {
    assert.deepEqual(valuesInCheck("CHECK ((status = ANY (ARRAY['active'::text, 'past_due'::text])))"), ['active', 'past_due']);
    assert.deepEqual(valuesInCheck("CHECK ((kind = ANY (ARRAY['it''s'::text])))"), ["it's"]);
    assert.equal(valuesInCheck('CHECK ((amount_cents >= 0))'), undefined);
  });
});

describe('Postgres connector as slime_reader (M3)', { skip: !hasDatabase }, () => {
  let reader: Connector;
  before(() => {
    reader = postgresConnector({ url: READER_URL });
  });
  after(() => reader.close());

  test('passes the startup safety check', async () => {
    assert.deepEqual(await reader.safetyCheck(), { ok: true, user: 'slime_reader', problems: [] });
  });

  test('describes only granted columns, with keys, comments and CHECK enum values', async () => {
    const { dialect, tables } = await reader.describe();
    const table = (name: string) => tables.find((candidate) => candidate.name === name);
    const accounts = table('accounts');
    assert.match(dialect, /^postgresql 16/);
    assert.ok(accounts?.columns.some(({ name }) => name === 'email'));
    assert.ok(!accounts?.columns.some(({ name }) => name === 'password_hash'));
    assert.deepEqual(accounts?.primaryKey, ['id']);
    assert.ok(accounts?.foreignKeys.some(({ column, references }) => column === 'plan_id' && references === 'plans.id'));
    assert.deepEqual(table('subscriptions')?.columns.find(({ name }) => name === 'status')?.values, ['active', 'past_due', 'canceled']);
    assert.match(table('usage_events')?.comment ?? '', /churn risk/);
  });

  test('runs a parameterized query and returns counts and sums as numbers', async () => {
    const plans = await reader.run('SELECT name FROM plans WHERE monthly_price_cents >= $1::int ORDER BY name', [9900], LIMITS);
    assert.deepEqual(plans.rows.map(({ name }) => name), ['Enterprise', 'Growth']);
    const [totals] = (await reader.run('SELECT count(*) AS n, sum(amount_cents) AS s FROM invoices', [], LIMITS)).rows;
    assert.deepEqual([typeof totals?.n, typeof totals?.s], ['number', 'number']);
  });

  test('refuses hidden columns and other schemas with ACCESS_DENIED', async () => {
    assert.equal(await errorCode(reader.run('SELECT password_hash FROM accounts', [], LIMITS)), 'ACCESS_DENIED');
    await asWriter(WRITER_FIXTURE);
    assert.equal(await errorCode(reader.run('SELECT * FROM slime_meta.probe', [], LIMITS)), 'ACCESS_DENIED');
  });

  test('turns a second statement into a syntax error, and refuses a write hidden in WITH', async () => {
    assert.equal(await errorCode(reader.run('SELECT 1; DELETE FROM plans', [], LIMITS)), 'QUERY_ERROR');
    assert.notEqual(await errorCode(reader.run('WITH d AS (DELETE FROM plans RETURNING *) SELECT * FROM d', [], LIMITS)), 'OK');
  });

  test('stops a query that lifts its own timeout with set_config', async () => {
    const startedAt = performance.now();
    const code = await errorCode(reader.run("SELECT set_config('statement_timeout', '0', true), pg_sleep(3)", [], { ...LIMITS, timeoutMs: 300 }));
    assert.equal(code, 'EXECUTION_TIMEOUT');
    assert.ok(performance.now() - startedAt < 2_500, 'the client-side timeout stopped it');
  });

  test('caps rows at rowCap and says so', async () => {
    const result = await reader.run('SELECT g FROM generate_series(1, 10) AS g', [], { ...LIMITS, rowCap: 5 });
    assert.deepEqual([result.rows.length, result.truncated], [5, true]);
  });

  test('check reports the planner cost without running the query', async () => {
    const { cost } = await reader.check('SELECT * FROM invoices', [], LIMITS);
    assert.ok(cost > 1, `cost ${cost}`);
  });
});

describe('Postgres connector with other credentials (M3)', { skip: !hasDatabase }, () => {
  before(() => asWriter(WRITER_FIXTURE));

  test('the safety check refuses a user that can write', async () => {
    const writer = postgresConnector({ url: WRITER_URL });
    try {
      const report = await writer.safetyCheck();
      assert.equal(report.ok, false);
      assert.ok(report.problems.some((problem) => problem.includes('slime_meta.probe')));
    } finally {
      await writer.close();
    }
  });

  test('describe reads the labels of Postgres enum types (D1)', async () => {
    const writer = postgresConnector({ url: WRITER_URL, schema: 'slime_meta' });
    try {
      const probe = (await writer.describe()).tables.find(({ name }) => name === 'probe');
      assert.deepEqual(probe?.columns.find(({ name }) => name === 'tier')?.values, ['gas', 'liquid', 'crystal']);
    } finally {
      await writer.close();
    }
  });
});

describe('engine on Postgres (M3)', { skip: !hasDatabase }, () => {
  test('answers a request end to end with the offline generator', async () => {
    const intent = 'plans priced at least a minimum, by name';
    const generator = offlineGenerator({ [intent]: artifact('SELECT name FROM plans WHERE monthly_price_cents >= $1::int ORDER BY name', ['minPriceCents']) });
    const slime = await createSlime(new SlimeConfig({ connector: postgresConnector({ url: READER_URL }), generator, store: memoryStore() }));
    try {
      const { data } = await slime.query({ intent, input: { minPriceCents: 9900 }, output: [{ name: 'string' }] });
      assert.deepEqual(data, [{ name: 'Enterprise' }, { name: 'Growth' }]);
    } finally {
      await slime.close();
    }
  });

  test('createSlime refuses a user that can write', async () => {
    const config = new SlimeConfig({ connector: postgresConnector({ url: WRITER_URL }), store: memoryStore() });
    await assert.rejects(createSlime(config), /can write to/);
  });
});
