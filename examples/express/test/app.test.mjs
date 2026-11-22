// The example end to end: its endpoints against the demo database, with canned
// handlers instead of a model. CI runs it from the packed core tarball.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createSlime, memoryStore } from '@slime-cloud/core';
import { cannedGenerator } from '@slime-cloud/core/testing';
import { createApp } from '../src/app.mjs';
import { slimeConfigFromEnv } from '../src/config.mjs';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const ENV = { DATABASE_URL };
const CANNED_HANDLERS = JSON.parse(readFileSync(new URL('./canned-handlers.json', import.meta.url), 'utf8'));
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
  const slime = await createSlime(await slimeConfigFromEnv(env, { store: memoryStore(), generator: cannedGenerator(CANNED_HANDLERS) }));
  const server = createApp(slime, options).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;
  const stop = async () => {
    server.close();
    await slime.close();
  };
  return { baseUrl, stop };
}

describe('example app (canned handlers)', { skip: !hasDatabase }, () => {
  let app;
  before(async () => {
    app = await startServer(ENV, { exposeDevQuery: true });
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

  test('POST /dev/query answers any request when it is enabled', async () => {
    const response = await fetch(`${app.baseUrl}/dev/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'number of accounts on each plan', output: [{ plan: 'string', accounts: 'integer' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.length, 4);
  });
});

describe('example app without /dev/query', { skip: !hasDatabase }, () => {
  let app;
  before(async () => {
    app = await startServer(ENV);
  });
  after(() => app.stop());

  test('named endpoints still answer, and /dev/query does not exist', async () => {
    assert.equal((await fetch(`${app.baseUrl}/api/plans/accounts`)).status, 200);
    assert.equal((await fetch(`${app.baseUrl}/dev/query`, { method: 'POST' })).status, 404);
  });
});
