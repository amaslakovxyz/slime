// The example end to end: its endpoints against the demo database, with canned
// handlers instead of a model. CI runs it from the packed core tarball.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createSlime, memoryStore } from '@slime-cloud/core';
import { cannedGenerator } from '@slime-cloud/core/testing';
import { Crystallizer } from '@slime-cloud/crystal';
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

const TOP_ACCOUNTS = { intent: 'top N accounts by total paid invoice amount in cents, highest first', output: [{ name: 'string', totalPaidCents: 'integer' }] };

/** A fresh instance on the demo database, with a Crystallizer writing into a temporary folder. */
async function startServer(env) {
  // crystal: false — the tests grow their own handlers, whatever slime-crystal/ holds.
  const slime = await createSlime(await slimeConfigFromEnv(env, { store: memoryStore(), generator: cannedGenerator(CANNED_HANDLERS), crystal: false }));
  const dir = await mkdtemp(join(tmpdir(), 'slime-example-crystal-'));
  const server = createApp(slime, new Crystallizer(slime, { dir })).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;
  const post = (path, body) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const stop = async () => {
    server.close();
    await slime.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { baseUrl, dir, post, stop };
}

describe('example app (canned handlers)', { skip: !hasDatabase }, () => {
  let app;
  before(async () => {
    app = await startServer(ENV);
  });
  after(() => app.stop());

  test('POST /query answers, and a repeat with other values reuses the handler', async () => {
    const first = await (await app.post('/query', { ...TOP_ACCOUNTS, input: { limit: 3 } })).json();
    const second = await (await app.post('/query', { ...TOP_ACCOUNTS, input: { limit: 5 } })).json();
    assert.equal(first.data.length, 3);
    assert.deepEqual(Object.keys(first.data[0]).sort(), ['name', 'totalPaidCents']);
    assert.deepEqual([first.meta.cache, second.meta.cache, second.data.length], ['miss', 'hit', 5]);
  });

  test('a bad input value is a 400 with a SlimeError body', async () => {
    const response = await app.post('/query', { ...TOP_ACCOUNTS, input: { limit: 'many' } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  });

  test('a malformed JSON body is a 400 that is not retryable', async () => {
    const response = await app.post('/query', '{intent:');
    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.deepEqual([error.code, error.retryable], ['INVALID_REQUEST', false]);
  });

  test('POST /crystallize refuses keys that are not a list of strings', async () => {
    const response = await app.post('/crystallize', { keys: 'all' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  });

  test('GET /health returns the stats', async () => {
    const response = await fetch(`${app.baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).handlers);
  });
});

describe('example app: POST /crystallize', { skip: !hasDatabase }, () => {
  let app;
  before(async () => {
    app = await startServer(ENV);
  });
  after(() => app.stop());

  test('turns a handler used ten times into Crystal with a typed service method', async () => {
    for (let limit = 1; limit <= 10; limit++) assert.equal((await app.post('/query', { ...TOP_ACCOUNTS, input: { limit } })).status, 200);
    const { reports } = await (await app.post('/crystallize', {})).json();
    assert.deepEqual(reports.map(({ outcome }) => outcome), ['crystallized']);
    const manifest = JSON.parse(await readFile(join(app.dir, 'manifest.json'), 'utf8'));
    const [entry] = Object.values(manifest.entries);
    assert.equal(entry.service, 'topNAccountsByTotalPaid');
    assert.match(await readFile(join(app.dir, 'services.mjs'), 'utf8'), /export const topNAccountsByTotalPaid = /);
  });
});
