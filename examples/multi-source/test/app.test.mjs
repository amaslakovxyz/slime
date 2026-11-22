// The three demo intents end to end (T7): demo Postgres, replayed Notion and
// films responses, the offline handlers. Skipped without Postgres unless REQUIRE_DB=1.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { createSlime } from '@slime-cloud/core';
import { createApp } from '../src/app.mjs';
import { slimeConfigFromEnv } from '../src/config.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const ENV = { FETCH_FIXTURES: '1', DATABASE_URL };

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
  before(async () => {
    slime = await createSlime(await slimeConfigFromEnv(ENV));
    app = createApp(slime);
  });
  after(() => slime?.close());

  const ask = async (body) => {
    const response = await app.request('/slime', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  test('/health reports explore mode', async () => {
    assert.equal((await (await app.request('/health')).json()).mode, 'explore');
  });

  test('intent 1: Postgres + Notion', async () => {
    const { status, body } = await ask({
      intent: 'accounts on a given plan with their total paid revenue in cents and their number of open negative feedback items, most open items first',
      input: { plan: 'Enterprise' },
      output: [{ name: 'string', paidCents: 'integer', openNegative: 'integer' }],
    });
    assert.equal(status, 200, JSON.stringify(body));
    const notionRows = body.meta.steps.find((step) => step.source === 'notion').rows;
    const counted = body.data.reduce((sum, row) => sum + row.openNegative, 0);
    assert.ok(counted > 0 && counted <= notionRows, `${counted} counted of ${notionRows} Notion rows`);
    assert.ok(body.data.every((row, index, rows) => index === 0 || rows[index - 1].openNegative >= row.openNegative), 'most open items first');
    assert.deepEqual(body.meta.steps.map((step) => step.source), ['db', 'notion']);
  });

  test('intent 2: Notion + films', async () => {
    const { status, body } = await ask({
      intent: "movie nights with each film's director and running time in minutes, newest first",
      output: [{ film: 'string', date: 'date|null', director: 'string|null', runningTimeMin: 'integer|null' }],
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.length, body.meta.steps.find((step) => step.source === 'notion').rows);
    assert.ok(body.data.every((row, index, rows) => index === 0 || (rows[index - 1].date ?? '') >= (row.date ?? '')), 'newest first');
    assert.ok(body.data.some((row) => row.director !== null && Number.isInteger(row.runningTimeMin)), 'nights are matched to films');
  });

  test('intent 3: films alone, filtered on the server', async () => {
    const { status, body } = await ask({ intent: 'films by a given director with their Rotten Tomatoes score, highest first', input: { director: 'Isao Takahata' }, output: [{ title: 'string', rtScore: 'integer' }] });
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
});
