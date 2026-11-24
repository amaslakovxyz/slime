// Connection URL rules and masking, and the Postgres connection test. The live
// tests use the demo database from the repo's docker setup and skip when it is down,
// unless REQUIRE_DB=1 (CI), where that is a failure.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { describe, test } from 'node:test';
import pg from 'pg';
import { maskConnectionUrl, validateConnectionUrl } from '../lib/connectors';
import { testConnection } from '../lib/connectors/postgres';
import { CodedError } from '../lib/errors';

const DEMO_URL = 'postgres://slime_reader:slime_reader@127.0.0.1:54329/slime';
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

describe('validateConnectionUrl', () => {
  const POOLER = 'aws-1-eu-west-1.pooler.supabase.com';
  const invalid = (type: string, url: string, message: RegExp) =>
    assert.throws(() => validateConnectionUrl(type, url), (err) => err instanceof CodedError && err.code === 'INVALID' && message.test(err.message));

  test('Postgres URLs are stored as typed, only trimmed', () => {
    assert.equal(validateConnectionUrl('postgres', ' postgres://r:p@db.example.com/app?sslmode=require '), 'postgres://r:p@db.example.com/app?sslmode=require');
  });

  test('Supabase adds TLS the runtime can use when the URL has none', () => {
    assert.equal(
      validateConnectionUrl('supabase', `postgresql://slime_reader.abcdefghijklmnopqrst:p%40ss@${POOLER}:6543/postgres`),
      `postgresql://slime_reader.abcdefghijklmnopqrst:p%40ss@${POOLER}:6543/postgres?sslmode=require&uselibpqcompat=true`,
    );
  });

  test('Supabase require, prefer and libpq-incompatible require all become encrypted libpq require', () => {
    const base = `postgresql://slime_reader.ref123:p@${POOLER}:5432/postgres`;
    const stored = `${base}?sslmode=require&uselibpqcompat=true`;
    assert.equal(validateConnectionUrl('supabase', `${base}?sslmode=require`), stored);
    assert.equal(validateConnectionUrl('supabase', `${base}?sslmode=prefer`), stored);
    assert.equal(validateConnectionUrl('supabase', `${base}?sslmode=require&uselibpqcompat=false`), stored);
  });

  test('Supabase refuses plaintext modes and certificate checks it cannot perform', () => {
    const base = `postgresql://slime_reader.ref123:p@${POOLER}:5432/postgres`;
    invalid('supabase', `${base}?sslmode=disable`, /plaintext/);
    invalid('supabase', `${base}?sslmode=allow`, /plaintext/);
    invalid('supabase', `${base}?sslmode=verify-ca`, /cannot verify/);
    invalid('supabase', `${base}?sslmode=verify-full`, /cannot verify/);
  });

  test('Supabase refuses TLS parameters that name files on the server', () => {
    const base = `postgresql://slime_reader.ref123:p@${POOLER}:5432/postgres`;
    invalid('supabase', `${base}?sslmode=verify-full&sslrootcert=/etc/passwd`, /sslrootcert is a file path/);
    invalid('supabase', `${base}?sslcert=/tmp/c.pem`, /sslcert is a file path/);
    invalid('supabase', `${base}?sslkey=/tmp/k.pem`, /sslkey is a file path/);
  });

  test('a malformed percent escape in the user is a form error, not a crash', () => {
    invalid('supabase', `postgresql://slime_reader%ZZ.ref:p@${POOLER}:6543/postgres`, /could not be parsed/);
  });

  test('Supabase refuses the IPv6-only direct host and points at the pooler', () => {
    invalid('supabase', 'postgresql://postgres:p@db.abcdefghijklmnopqrst.supabase.co:5432/postgres', /IPv6-only.*pooler/);
  });

  test('Supabase refuses other hosts, ports and users without the project ref', () => {
    invalid('supabase', 'postgresql://reader.ref:p@db.example.com:5432/app', /pooler host/);
    invalid('supabase', `postgresql://slime_reader.ref:p@${POOLER}:5433/postgres`, /5432 \(session\) or 6543/);
    invalid('supabase', `postgresql://slime_reader:p@${POOLER}:6543/postgres`, /<role>\.<project-ref>/);
    invalid('supabase', `mysql://slime_reader.ref:p@${POOLER}:6543/postgres`, /postgres:\/\//);
  });
});

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
    const result = await testConnection('postgres', DEMO_URL);
    assert.equal(result.error, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.user, 'slime_reader');
    assert.equal(result.database, 'slime');
    assert.match(result.serverVersion ?? '', /^\d+/);
    assert.ok((result.tables ?? 0) >= 5, `expected >= 5 tables, got ${result.tables}`);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings, []);
  });

  // The runtime describes only public, views included and materialized views not
  // (core/src/sources/sql/postgres/describe.ts), so the count matches what Slime can query.
  // Counts are relative to a baseline: locally the demo database is shared with other checkouts.
  test('counts only the tables the role can SELECT from (E2E-16)', { skip: skipDb }, async () => {
    // REFERENCES alone shows the columns in information_schema but gives no read access.
    const table = `public.ref_${randomBytes(4).toString('hex')}`;
    const before = (await testConnection('postgres', DEMO_URL)).tables;
    await asAdmin(`CREATE TABLE ${table} (id int); GRANT REFERENCES ON ${table} TO slime_reader`);
    try {
      const result = await testConnection('postgres', DEMO_URL);
      assert.equal(result.tables, before);
      assert.equal(result.ok, true);
    } finally {
      await asAdmin(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  test('counts the views in public the role can read', { skip: skipDb }, async () => {
    const view = `public.view_${randomBytes(4).toString('hex')}`;
    const before = (await testConnection('postgres', DEMO_URL)).tables!;
    await asAdmin(`CREATE VIEW ${view} AS SELECT id FROM plans; GRANT SELECT ON ${view} TO slime_reader`);
    try {
      assert.equal((await testConnection('postgres', DEMO_URL)).tables, before + 1);
    } finally {
      await asAdmin(`DROP VIEW IF EXISTS ${view}`);
    }
  });

  test('leaves out readable tables outside public and materialized views', { skip: skipDb }, async () => {
    const suffix = randomBytes(4).toString('hex');
    const schema = `other_${suffix}`;
    const matview = `public.matview_${suffix}`;
    const before = (await testConnection('postgres', DEMO_URL)).tables;
    await asAdmin(`
      CREATE SCHEMA ${schema}; GRANT USAGE ON SCHEMA ${schema} TO slime_reader;
      CREATE TABLE ${schema}.readable (id int); GRANT SELECT ON ${schema}.readable TO slime_reader;
      CREATE MATERIALIZED VIEW ${matview} AS SELECT id FROM plans; GRANT SELECT ON ${matview} TO slime_reader`);
    try {
      assert.equal((await testConnection('postgres', DEMO_URL)).tables, before);
    } finally {
      await asAdmin(`DROP MATERIALIZED VIEW IF EXISTS ${matview}; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  test('warns when RLS hides every row of a readable table, until a policy lets the role in', { skip: skipDb }, async () => {
    const table = `public.rls_${randomBytes(4).toString('hex')}`;
    // A policy for another role (Supabase's anon/authenticated) does not count.
    await asAdmin(`
      CREATE TABLE ${table} (id int); ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON ${table} TO slime_reader;
      CREATE POLICY others ON ${table} FOR SELECT TO slime_writer USING (true)`);
    try {
      const hidden = await testConnection('postgres', DEMO_URL);
      assert.equal(hidden.ok, true, 'RLS is a warning, not an unsafe role');
      assert.equal(hidden.warnings.length, 1);
      assert.match(hidden.warnings[0], new RegExp(table.replace('public.', '')));

      await asAdmin(`CREATE POLICY reader ON ${table} FOR SELECT TO slime_reader USING (true)`);
      assert.deepEqual((await testConnection('postgres', DEMO_URL)).warnings, []);
    } finally {
      await asAdmin(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  test('a URL that cannot connect is not ok and says why', async () => {
    const result = await testConnection('postgres', 'postgres://nobody:wrong@127.0.0.1:1/nope');
    assert.equal(result.ok, false);
    assert.ok(result.error, 'error should be set');
    assert.equal(result.user, null);
  });

  test('a non-Postgres URL is rejected without connecting', async () => {
    const result = await testConnection('postgres', 'mysql://root@localhost/db');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /postgres:\/\//);
  });

  test('the Supabase rules apply before connecting', async () => {
    const result = await testConnection('supabase', 'postgresql://postgres:p@db.abcdefghijklmnopqrst.supabase.co:5432/postgres');
    assert.equal(result.ok, false);
    assert.equal(result.user, null);
    assert.match(result.error ?? '', /IPv6-only/);
  });
});
