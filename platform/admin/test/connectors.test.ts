// Connection URL rules and masking, and the Postgres connection test. The live
// tests use the demo database from the repo's docker setup and skip when it is down.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { describe, test } from 'node:test';
import pg from 'pg';
import { maskConnectionUrl, validateConnectionUrl } from '../lib/connectors';
import { testConnection } from '../lib/connectors/postgres';
import { CodedError } from '../lib/errors';

const DEMO_URL = 'postgres://slime_reader:slime_reader@127.0.0.1:54329/slime';
// Owns slime_meta, which slime_reader cannot read (examples/express/db/init.sql).
const WRITER_URL = 'postgres://slime_writer:slime_writer@127.0.0.1:54329/slime';
// The compose superuser (examples/express/docker-compose.yml), for RLS fixtures.
const ADMIN_URL = 'postgres://slime_admin:slime_admin@127.0.0.1:54329/slime';
const demoUp = await new Promise<boolean>((resolve) => {
  const socket = connect(54329, '127.0.0.1');
  socket.setTimeout(1000);
  socket.once('connect', () => (socket.destroy(), resolve(true)));
  socket.once('timeout', () => (socket.destroy(), resolve(false)));
  socket.once('error', () => resolve(false));
});

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
  test('reports the role, database and table count of the demo database', { skip: demoUp ? false : 'demo Postgres on 127.0.0.1:54329 is down' }, async () => {
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

  test('counts only the tables the role can read (E2E-16)', { skip: demoUp ? false : 'demo Postgres on 127.0.0.1:54329 is down' }, async () => {
    const hidden = `slime_meta.hidden_${randomBytes(4).toString('hex')}`;
    const writer = new pg.Client({ connectionString: WRITER_URL });
    await writer.connect();
    try {
      await writer.query(`CREATE TABLE ${hidden} (id int)`);
      // accounts, invoices, plans, subscriptions, usage_events
      assert.equal((await testConnection('postgres', DEMO_URL)).tables, 5);
    } finally {
      await writer.query(`DROP TABLE IF EXISTS ${hidden}`);
      await writer.end();
    }
  });

  test('warns when RLS hides every row of a readable table, until a policy lets the role in', { skip: demoUp ? false : 'demo Postgres on 127.0.0.1:54329 is down' }, async () => {
    const schema = `rls_${randomBytes(4).toString('hex')}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO slime_reader`);
      await admin.query(`CREATE TABLE ${schema}.profiles (id int)`);
      await admin.query(`ALTER TABLE ${schema}.profiles ENABLE ROW LEVEL SECURITY`);
      await admin.query(`GRANT SELECT ON ${schema}.profiles TO slime_reader`);
      // A policy for another role (Supabase's anon/authenticated) does not count.
      await admin.query(`CREATE POLICY others ON ${schema}.profiles FOR SELECT TO slime_writer USING (true)`);

      const hidden = await testConnection('postgres', DEMO_URL);
      assert.equal(hidden.ok, true, 'RLS is a warning, not an unsafe role');
      assert.equal(hidden.warnings.length, 1);
      assert.match(hidden.warnings[0], new RegExp(`${schema}\\.profiles`));

      await admin.query(`CREATE POLICY reader ON ${schema}.profiles FOR SELECT TO slime_reader USING (true)`);
      assert.deepEqual((await testConnection('postgres', DEMO_URL)).warnings, []);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
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
