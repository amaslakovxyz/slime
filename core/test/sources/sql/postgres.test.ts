// The Postgres connector against the demo database, as the read-only slime_reader (M3):
// the shared Connector contract, then what is specific to Postgres.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SlimeConfig } from '../../../src/config/slime-config.js';
import { createSlime } from '../../../src/create-slime.js';
import { SlimeError } from '../../../src/shared/errors.js';
import type { Connector, QueryLimits } from '../../../src/sources/sql/types.js';
import { valuesInCheck } from '../../../src/sources/sql/postgres/enum-values.js';
import { postgresConnector } from '../../../src/sources/sql/postgres/index.js';
import { memoryStore } from '../../../src/stores/memory-store.js';
import { READER_URL, WRITER_URL, asWriter, isDatabaseAvailable } from '../../support/database.js';
import { describeConnectorContract } from '../../../src/testing/connector-contract.js';
import { cannedGenerator } from '../../../src/testing/canned-generator.js';
import { artifact, fakeGenerator } from '../../../src/testing/fakes.js';

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

describeConnectorContract('postgres', {
  createReader: () => postgresConnector({ url: READER_URL }),
  createWriter: async () => {
    await asWriter(WRITER_FIXTURE);
    return postgresConnector({ url: WRITER_URL });
  },
  queries: {
    parameterized: { sql: 'SELECT name FROM plans WHERE monthly_price_cents >= $1::int ORDER BY name', params: [9900], rows: [{ name: 'Enterprise' }, { name: 'Growth' }] },
    aggregates: 'SELECT count(*) AS n, sum(amount_cents) AS s FROM invoices',
    manyRows: 'SELECT g FROM generate_series(1, 20) AS g',
    write: 'DELETE FROM plans',
    slow: 'SELECT pg_sleep(5)',
  },
  describes: { table: 'accounts', hiddenColumn: 'password_hash' },
  skip: !hasDatabase,
});

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

  test('refuses hidden columns and other schemas with ACCESS_DENIED', async () => {
    assert.equal(await errorCode(reader.run('SELECT password_hash FROM accounts', [], LIMITS)), 'ACCESS_DENIED');
    await asWriter(WRITER_FIXTURE);
    assert.equal(await errorCode(reader.run('SELECT * FROM slime_meta.probe', [], LIMITS)), 'ACCESS_DENIED');
  });

  test('reports the reader as slime_reader, turns a second statement into a syntax error, and refuses a write hidden in WITH', async () => {
    assert.equal((await reader.safetyCheck()).user, 'slime_reader');
    assert.equal(await errorCode(reader.run('SELECT 1; DELETE FROM plans', [], LIMITS)), 'QUERY_ERROR');
    assert.notEqual(await errorCode(reader.run('WITH d AS (DELETE FROM plans RETURNING *) SELECT * FROM d', [], LIMITS)), 'OK');
  });

  test('stops a query that lifts its own timeout with set_config', async () => {
    const startedAt = performance.now();
    const code = await errorCode(reader.run("SELECT set_config('statement_timeout', '0', true), pg_sleep(3)", [], { ...LIMITS, timeoutMs: 300 }));
    assert.equal(code, 'EXECUTION_TIMEOUT');
    assert.ok(performance.now() - startedAt < 2_500, 'the client-side timeout stopped it');
  });

  test('a caller value the SQL cannot cast is INVALID_REQUEST; a bad cast of table data stays QUERY_ERROR', async () => {
    assert.equal(await errorCode(reader.run('SELECT name FROM accounts LIMIT $1::int', ['many'], LIMITS)), 'INVALID_REQUEST');
    assert.equal(await errorCode(reader.run('SELECT name FROM accounts WHERE created_at > $1::timestamptz', ['yesterday-ish'], LIMITS)), 'INVALID_REQUEST');
    assert.equal(await errorCode(reader.run('SELECT name::int FROM accounts', [], LIMITS)), 'QUERY_ERROR');
  });

  test('check reports the planner cost without running the query', async () => {
    const { cost } = await reader.check('SELECT * FROM invoices', [], LIMITS);
    assert.ok(cost !== null && cost > 1, `cost ${cost}`);
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

  // The connector, not the user's grants, is under test: the writer may write, so only READ ONLY stops it.
  test('SQL that closes the wrapping subquery cannot run more statements past READ ONLY', async () => {
    const writer = postgresConnector({ url: WRITER_URL });
    const escape = (id: number) => `SELECT 1 AS x) AS a; COMMIT; INSERT INTO slime_meta.probe VALUES (${id}, 'gas'); SELECT * FROM (SELECT 1 AS x`;
    try {
      assert.equal(await errorCode(writer.run(escape(1), [], LIMITS)), 'QUERY_ERROR');
      assert.equal(await errorCode(writer.check(escape(2), [], LIMITS)), 'QUERY_ERROR');
      assert.deepEqual((await writer.run('SELECT count(*) AS n FROM slime_meta.probe', [], LIMITS)).rows, [{ n: 0 }]);
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
  test('answers a request end to end with canned handlers', async () => {
    const intent = 'plans priced at least a minimum, by name';
    const generator = cannedGenerator({ [intent]: artifact('SELECT name FROM plans WHERE monthly_price_cents >= $1::int ORDER BY name', ['minPriceCents']) });
    const slime = await createSlime(new SlimeConfig({ connector: postgresConnector({ url: READER_URL }), generator, store: memoryStore() }));
    try {
      const { data } = await slime.query({ intent, input: { minPriceCents: 9900 }, output: [{ name: 'string' }] });
      assert.deepEqual(data, [{ name: 'Enterprise' }, { name: 'Growth' }]);
    } finally {
      await slime.close();
    }
  });

  test('createSlime refuses a user that can write', async () => {
    const config = new SlimeConfig({ connector: postgresConnector({ url: WRITER_URL }), store: memoryStore(), generator: fakeGenerator() });
    await assert.rejects(createSlime(config), /can write to/);
  });
});
