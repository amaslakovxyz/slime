// The Postgres connector and the read-only database user: the real safety boundary.
import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { config } from '../src/config.js';
import { PostgresConnector } from '../src/connectors/postgres.js';
import { SlimeError } from '../src/errors.js';
import { PostgresHandlerStore } from '../src/store.js';
import { DB_URL, META_URL, dbAvailable, withConfig } from './helpers.js';

const hasDb = await dbAvailable();

describe('Postgres connector as slime_reader', { skip: !hasDb }, () => {
  let reader: PostgresConnector;
  before(() => {
    reader = new PostgresConnector(DB_URL);
  });
  after(async () => {
    await reader.close();
  });

  const errorCode = (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (e: unknown) => (e instanceof SlimeError ? e.code : `not a SlimeError: ${e}`),
    );

  test('passes the startup safety check', async () => {
    const report = await reader.safetyCheck();
    assert.deepEqual(report.problems, []);
    assert.equal(report.ok, true);
  });

  test('describes only granted columns, so hidden ones never reach a prompt', async () => {
    const schema = await reader.describe();
    const accounts = schema.tables.find((t) => t.name === 'accounts');
    assert.ok(accounts);
    assert.ok(accounts.columns.some((c) => c.name === 'email'));
    assert.ok(!accounts.columns.some((c) => c.name === 'password_hash'));
    assert.ok(accounts.foreignKeys.some((fk) => fk.column === 'plan_id' && fk.references === 'plans.id'));
  });

  test('runs a parameterized query', async () => {
    const r = await reader.run('SELECT name FROM plans WHERE monthly_price_cents >= $1::int ORDER BY name', [9900]);
    assert.deepEqual(r.rows.map((x) => x.name), ['Enterprise', 'Growth']);
  });

  test('returns counts and sums as numbers, not strings', async () => {
    const r = await reader.run('SELECT count(*) AS n, sum(amount_cents) AS s FROM invoices', []);
    assert.equal(typeof r.rows[0].n, 'number');
    assert.equal(typeof r.rows[0].s, 'number');
  });

  test('refuses a hidden column', async () => {
    assert.equal(await errorCode(reader.run('SELECT password_hash FROM accounts', [])), 'FIELD_NOT_EXPOSED');
  });

  test('turns a second statement into a syntax error', async () => {
    assert.equal(await errorCode(reader.run('SELECT 1; DELETE FROM plans', [])), 'QUERY_ERROR');
  });

  test('refuses a write hidden in a WITH clause', async () => {
    assert.notEqual(await errorCode(reader.run('WITH d AS (DELETE FROM plans RETURNING *) SELECT * FROM d', [])), 'OK');
  });

  test('cannot read Slime\'s own storage', async () => {
    assert.notEqual(await errorCode(reader.run('SELECT * FROM slime_meta.handlers', [])), 'OK');
  });

  test('stops a query that lifts its own timeout with set_config', async () => {
    const started = performance.now();
    const code = await errorCode(reader.run("SELECT set_config('statement_timeout', '0', true), pg_sleep(3)", []));
    assert.equal(code, 'EXECUTION_TIMEOUT');
    assert.ok(performance.now() - started < 2_500);
  });

  test('caps rows and says so', async () => {
    await withConfig({ rowCap: 5 }, async () => {
      const r = await reader.run('SELECT g FROM generate_series(1, 10) AS g', []);
      assert.equal(r.rows.length, 5);
      assert.equal(r.truncated, true);
    });
    assert.equal(config.rowCap > 5, true);
  });

  test('EXPLAIN check refuses queries above the cost cap', async () => {
    await withConfig({ maxQueryCost: 1 }, async () => {
      assert.equal(await errorCode(reader.check('SELECT * FROM invoices', [])), 'QUERY_TOO_EXPENSIVE');
    });
  });
});

describe('startup safety check', { skip: !hasDb }, () => {
  test('refuses credentials that can write', async () => {
    const store = new PostgresHandlerStore(META_URL);
    await store.init(); // slime_writer owns slime_meta.handlers, so it can write there
    await store.close();
    const writer = new PostgresConnector(META_URL);
    try {
      const report = await writer.safetyCheck();
      assert.equal(report.ok, false);
      assert.ok(report.problems.some((p) => p.includes('slime_meta.handlers')));
    } finally {
      await writer.close();
    }
  });
});
