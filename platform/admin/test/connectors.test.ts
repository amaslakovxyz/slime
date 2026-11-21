// Connection URL masking and the Postgres connection test. The live test uses
// the demo database from the repo's docker setup and skips when it is down.
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { describe, test } from 'node:test';
import { maskConnectionUrl } from '../lib/connectors';
import { testConnection } from '../lib/connectors/postgres';

const DEMO_URL = 'postgres://slime_reader:slime_reader@127.0.0.1:54329/slime';
const demoUp = await new Promise<boolean>((resolve) => {
  const socket = connect(54329, '127.0.0.1');
  socket.setTimeout(1000);
  socket.once('connect', () => (socket.destroy(), resolve(true)));
  socket.once('timeout', () => (socket.destroy(), resolve(false)));
  socket.once('error', () => resolve(false));
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
    const result = await testConnection(DEMO_URL);
    assert.equal(result.error, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.user, 'slime_reader');
    assert.equal(result.database, 'slime');
    assert.match(result.serverVersion ?? '', /^\d+/);
    assert.ok((result.tables ?? 0) >= 5, `expected >= 5 tables, got ${result.tables}`);
    assert.deepEqual(result.problems, []);
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
