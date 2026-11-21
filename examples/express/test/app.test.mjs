// The example end to end: its endpoints against the demo database, with the
// offline handlers instead of a model. CI runs it from the packed core tarball.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { createSlime, memoryStore } from '@slime-cloud/core';
import { createApp } from '../src/app.mjs';
import { slimeConfigFromEnv } from '../src/config.mjs';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const OFFLINE_ENV = { DATABASE_URL };
const hasDatabase = await isDatabaseAvailable();

async function isDatabaseAvailable() {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch (error) {
    if (process.env.REQUIRE_DB === '1') throw new Error(`REQUIRE_DB=1 but Postgres is unreachable: ${error.message}`);
    console.warn(`# skipping example tests: ${error.message} (start it with: npm run db:up)`);
    return false;
  }
}

async function startServer(env, options) {
  const slime = await createSlime(await slimeConfigFromEnv(env, { store: memoryStore() }));
  const server = createApp(slime, options).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;
  const stop = async () => {
    server.close();
    await slime.close();
  };
  return { baseUrl, stop };
}

describe('example app in explore mode (offline handlers)', { skip: !hasDatabase }, () => {
  let app;
  before(async () => {
    app = await startServer(OFFLINE_ENV, { exposeDevQuery: true });
  });
  after(() => app.stop());

  test('a named endpoint answers, and a repeat with other values reuses the handler', async () => {
    const first = await (await fetch(`${app.baseUrl}/api/accounts/top?limit=3`)).json();
    const second = await (await fetch(`${app.baseUrl}/api/accounts/top?limit=5`)).json();
    assert.equal(first.data.length, 3);
    assert.deepEqual(Object.keys(first.data[0]).sort(), ['name', 'totalPaidCents']);
    assert.deepEqual([first.meta.cache, second.meta.cache, second.data.length], ['miss', 'hit', 5]);
  });

  test('a bad parameter is a 400 with a SlimeError body', async () => {
    const response = await fetch(`${app.baseUrl}/api/accounts/top?limit=many`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  });

  test('a malformed JSON body is a 400 that is not retryable', async () => {
    const response = await fetch(`${app.baseUrl}/dev/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{intent:' });
    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.deepEqual([error.code, error.retryable], ['INVALID_REQUEST', false]);
  });

  test('POST /dev/query answers any request in explore mode', async () => {
    const response = await fetch(`${app.baseUrl}/dev/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'number of accounts on each plan', output: [{ plan: 'string', accounts: 'integer' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.length, 4);
  });
});

describe('example app in locked mode', { skip: !hasDatabase }, () => {
  let app;
  before(async () => {
    app = await startServer({ ...OFFLINE_ENV, SLIME_LOCKED: '1' });
  });
  after(() => app.stop());

  test('serves only saved handlers: an empty store answers 404, and /dev/query does not exist', async () => {
    const response = await fetch(`${app.baseUrl}/api/plans/accounts`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'HANDLER_NOT_FOUND');
    assert.equal((await fetch(`${app.baseUrl}/dev/query`, { method: 'POST' })).status, 404);
  });
});
