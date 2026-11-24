// Connection URL masking and the Postgres connection test. The live tests use
// the demo database from the repo's docker setup and skip when it is down,
// unless REQUIRE_DB=1 (CI), where that is a failure.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { describe, test } from 'node:test';
import pg from 'pg';
import { maskConnectionUrl } from '../lib/connectors';
import { testConnection } from '../lib/connectors/postgres';

const DEMO_URL = 'postgres://slime_reader:slime_reader@127.0.0.1:54329/slime';
// Owns slime_meta, which slime_reader cannot read (examples/express/db/init.sql).
const WRITER_URL = 'postgres://slime_writer:slime_writer@127.0.0.1:54329/slime';
// Creates objects in public and other schemas (examples/express/docker-compose.yml, CI service).
const ADMIN_URL = 'postgres://slime_admin:slime_admin@127.0.0.1:54329/slime';
const demoUp = await new Promise<boolean>((resolve) => {
  const socket = connect(54329, '127.0.0.1');
  socket.setTimeout(1000);
  socket.once('connect', () => (socket.destroy(), resolve(true)));
  socket.once('timeout', () => (socket.destroy(), resolve(false)));
  socket.once('error', () => resolve(false));
});
const skipDb = demoUp || process.env.REQUIRE_DB === '1' ? false : 'demo Postgres on 127.0.0.1:54329 is down';

async function asAdmin(sql: string): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

describe('maskConnectionUrl', () => {
  test('shows everything but the password', () => {
    const masked = maskConnectionUrl('postgresql://reader:s3cr%40t@db.example.com:6543/app?sslmode=require&password=x');
    assert.deepEqual(
      { ...masked, display: undefined },
      { scheme: 'postgresql', user: 'reader', host: 'db.example.com', port: '6543', database: 'app', display: undefined },
    );
    assert.equal(masked?.display, 'postgresql://reader:****@db.example.com:6543/app?sslmode=require');
    assert.doesNotMatch(masked!.display, /s3cr|%40t|password/);
  });

  test('defaults the port and survives URLs without credentials or garbage', () => {
    assert.equal(maskConnectionUrl('postgres://db.local/shop')?.display, 'postgres://db.local:5432/shop');
    assert.equal(maskConnectionUrl('not a url'), null);
  });
});

describe('testConnection', () => {
  test('reports the role, database and table count of the demo database', { skip: skipDb }, async () => {
    const result = await testConnection(DEMO_URL);
    assert.equal(result.error, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.user, 'slime_reader');
    assert.equal(result.database, 'slime');
    assert.match(result.serverVersion ?? '', /^\d+/);
    assert.ok((result.tables ?? 0) >= 5, `expected >= 5 tables, got ${result.tables}`);
    assert.deepEqual(result.problems, []);
  });

  test('counts only the tables the role can read (E2E-16)', { skip: skipDb }, async () => {
    const hidden = `slime_meta.hidden_${randomBytes(4).toString('hex')}`;
    const writer = new pg.Client({ connectionString: WRITER_URL });
    await writer.connect();
    try {
      await writer.query(`CREATE TABLE ${hidden} (id int)`);
      // accounts, invoices, plans, subscriptions, usage_events
      assert.equal((await testConnection(DEMO_URL)).tables, 5);
    } finally {
      await writer.query(`DROP TABLE IF EXISTS ${hidden}`);
      await writer.end();
    }
  });

  // The runtime describes only public, views included and materialized views not
  // (core/src/sources/sql/postgres/describe.ts), so the count matches what Slime can query.
  test('counts the views in public the role can read', { skip: skipDb }, async () => {
    const view = `public.view_${randomBytes(4).toString('hex')}`;
    await asAdmin(`CREATE VIEW ${view} AS SELECT id FROM plans; GRANT SELECT ON ${view} TO slime_reader`);
    try {
      assert.equal((await testConnection(DEMO_URL)).tables, 6);
    } finally {
      await asAdmin(`DROP VIEW IF EXISTS ${view}`);
    }
  });

  test('leaves out readable tables outside public and materialized views', { skip: skipDb }, async () => {
    const suffix = randomBytes(4).toString('hex');
    const schema = `other_${suffix}`;
    const matview = `public.matview_${suffix}`;
    await asAdmin(`
      CREATE SCHEMA ${schema}; GRANT USAGE ON SCHEMA ${schema} TO slime_reader;
      CREATE TABLE ${schema}.readable (id int); GRANT SELECT ON ${schema}.readable TO slime_reader;
      CREATE MATERIALIZED VIEW ${matview} AS SELECT id FROM plans; GRANT SELECT ON ${matview} TO slime_reader`);
    try {
      assert.equal((await testConnection(DEMO_URL)).tables, 5);
    } finally {
      await asAdmin(`DROP MATERIALIZED VIEW IF EXISTS ${matview}; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  test('a URL that cannot connect is not ok and says why', async () => {
    const result = await testConnection('postgres://nobody:wrong@127.0.0.1:1/nope');
    assert.equal(result.ok, false);
    assert.ok(result.error, 'error should be set');
    assert.equal(result.user, null);
  });

  test('a non-Postgres URL is rejected without connecting', async () => {
    const result = await testConnection('mysql://root@localhost/db');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /postgres:\/\//);
  });
});
