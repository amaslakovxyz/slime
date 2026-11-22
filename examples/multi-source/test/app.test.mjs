// The three demo intents end to end (T7): demo Postgres, replayed Notion and
// films responses, canned handlers instead of a model. Skipped without Postgres unless REQUIRE_DB=1.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { createSlime, memoryStore } from '@slime-cloud/core';
import { cannedGenerator } from '@slime-cloud/core/testing';
import { Crystallizer } from '@slime-cloud/crystal';
import { createApp } from '../src/app.mjs';
import { slimeConfigFromEnv } from '../src/config.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const ENV = { FETCH_FIXTURES: '1', DATABASE_URL };
const CANNED_HANDLERS = JSON.parse(readFileSync(new URL('./canned-handlers.json', import.meta.url), 'utf8'));

/** The three demo intents. */
const POSTGRES_AND_NOTION = {
  intent: 'accounts on a given plan with their total paid revenue in cents and their number of open negative feedback items, most open items first',
  input: { plan: 'Enterprise' },
  output: [{ name: 'string', paidCents: 'integer', openNegative: 'integer' }],
};
const NOTION_AND_FILMS = {
  intent: "movie nights with each film's director and running time in minutes, newest first",
  output: [{ film: 'string', date: 'date|null', director: 'string|null', runningTimeMin: 'integer|null' }],
};
const FILMS_ALONE = { intent: 'films by a given director with their Rotten Tomatoes score, highest first', input: { director: 'Isao Takahata' }, output: [{ title: 'string', rtScore: 'integer' }] };

async function isDatabaseAvailable() {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch (error) {
    if (process.env.REQUIRE_DB === '1') throw error;
    return false;
  }
}

const isDatabaseUp = await isDatabaseAvailable();

describe('the multi-source example', { skip: !isDatabaseUp && 'Postgres is not running (cd ../express && npm run db:up)' }, () => {
  let slime;
  let app;
  let dir;
  before(async () => {
    // crystal: false — the tests grow their own handlers, whatever slime-crystal/ holds.
    slime = await createSlime(await slimeConfigFromEnv(ENV, { store: memoryStore(), generator: cannedGenerator(CANNED_HANDLERS), crystal: false }));
    dir = await mkdtemp(join(tmpdir(), 'slime-multi-source-crystal-'));
    app = createApp(slime, new Crystallizer(slime, { dir }));
  });
  after(async () => {
    await slime?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const ask = async (body) => {
    const response = await app.request('/slime', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  test('/health reports the handler counts', async () => {
    assert.deepEqual(Object.keys((await (await app.request('/health')).json()).handlers).sort(), ['gas', 'liquid']);
  });

  test('intent 1: Postgres + Notion', async () => {
    const { status, body } = await ask(POSTGRES_AND_NOTION);
    assert.equal(status, 200, JSON.stringify(body));
    const notionRows = body.meta.steps.find((step) => step.source === 'notion').rows;
    const counted = body.data.reduce((sum, row) => sum + row.openNegative, 0);
    assert.ok(counted > 0 && counted <= notionRows, `${counted} counted of ${notionRows} Notion rows`);
    assert.ok(body.data.every((row, index, rows) => index === 0 || rows[index - 1].openNegative >= row.openNegative), 'most open items first');
    assert.deepEqual(body.meta.steps.map((step) => step.source), ['db', 'notion']);
  });

  test('intent 2: Notion + films', async () => {
    const { status, body } = await ask(NOTION_AND_FILMS);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.length, body.meta.steps.find((step) => step.source === 'notion').rows);
    assert.ok(body.data.every((row, index, rows) => index === 0 || (rows[index - 1].date ?? '') >= (row.date ?? '')), 'newest first');
    assert.ok(body.data.some((row) => row.director !== null && Number.isInteger(row.runningTimeMin)), 'nights are matched to films');
  });

  test('intent 3: films alone, filtered on the server', async () => {
    const { status, body } = await ask(FILMS_ALONE);
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.data.length > 0);
    assert.ok(body.data.every((film, index, films) => index === 0 || films[index - 1].rtScore >= film.rtScore));
  });

  test('a malformed JSON body is a 400 that is not retryable', async () => {
    const response = await app.request('/slime', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{intent:' });
    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.deepEqual([error.code, error.retryable], ['INVALID_REQUEST', false]);
  });

  test('POST /crystallize turns the three intents into Crystal, which a new instance serves', async () => {
    // Ready first: 10 successful runs each (each intent ran once above).
    for (const body of [POSTGRES_AND_NOTION, NOTION_AND_FILMS, FILMS_ALONE]) for (let run = 0; run < 9; run++) assert.equal((await ask(body)).status, 200);
    const response = await app.request('/crystallize', { method: 'POST' });
    assert.equal(response.status, 200);
    const { reports } = await response.json();
    assert.deepEqual(reports.map(({ outcome }) => outcome), ['crystallized', 'crystallized', 'crystallized'], JSON.stringify(reports));

    const { crystals } = await import(pathToFileURL(join(dir, 'index.mjs')).href);
    const served = await createSlime(await slimeConfigFromEnv(ENV, { store: memoryStore(), generator: cannedGenerator({}), crystal: crystals }));
    try {
      for (const body of [POSTGRES_AND_NOTION, NOTION_AND_FILMS, FILMS_ALONE]) {
        const [fromLiquid, fromCrystal] = [await slime.query(body), await served.query(body)];
        assert.equal(fromCrystal.meta.tier, 'crystal');
        assert.deepEqual(fromCrystal.data, fromLiquid.data);
      }
    } finally {
      await served.close();
    }
  });

  test('POST /crystallize refuses keys that are not a list of strings', async () => {
    const response = await app.request('/crystallize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"keys":"all"}' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  });
});
