// The three demo intents end to end (T7): demo Postgres, replayed Notion and
// films responses, canned handlers instead of a model. Skipped without Postgres unless REQUIRE_DB=1.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createSlime } from '@slime-cloud/core';
import { cannedGenerator } from '@slime-cloud/core/testing';
import { createApp } from '../src/app.mjs';
import { slimeConfigFromEnv } from '../src/config.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const ENV = { FETCH_FIXTURES: '1', DATABASE_URL };
const CANNED_HANDLERS = JSON.parse(readFileSync(new URL('./canned-handlers.json', import.meta.url), 'utf8'));

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
    slime = await createSlime(await slimeConfigFromEnv(ENV, { generator: cannedGenerator(CANNED_HANDLERS) }));
    app = createApp(slime);
  });
  after(() => slime?.close());

  const ask = async (body) => {
    const response = await app.request('/slime', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  test('/health reports the handler counts', async () => {
    assert.deepEqual(Object.keys((await (await app.request('/health')).json()).handlers).sort(), ['gas', 'liquid']);
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

  test('customer 360: Postgres + Notion + euro rates, revenue converted at the recorded rate', async () => {
    const converted = await ask({
      intent: 'accounts on a given plan with their total paid revenue converted into a given currency and their number of open negative feedback items, most open items first',
      input: { plan: 'Enterprise', currency: 'USD' },
      output: [{ name: 'string', paidRevenue: 'number', openNegative: 'integer' }],
    });
    assert.equal(converted.status, 200, JSON.stringify(converted.body));
    assert.deepEqual(converted.body.meta.steps.map((step) => step.source), ['db', 'notion', 'rates']);
    const euros = await ask({
      intent: 'accounts on a given plan with their total paid revenue in cents and their number of open negative feedback items, most open items first',
      input: { plan: 'Enterprise' },
      output: [{ name: 'string', paidCents: 'integer', openNegative: 'integer' }],
    });
    const usdPerEur = JSON.parse(readFileSync(new URL('./fixtures/frankfurter/rates-usd.json', import.meta.url), 'utf8')).response.body.rates.USD;
    // The two answers sort differently, so compare the sorted amounts.
    const byNumber = (a, b) => a - b;
    const expected = euros.body.data.map((row) => Math.round(row.paidCents * usdPerEur) / 100).sort(byNumber);
    assert.ok(expected.length > 0 && expected.some((amount) => amount > 0));
    assert.deepEqual(converted.body.data.map((row) => row.paidRevenue).sort(byNumber), expected);
  });

  test('a malformed JSON body is a 400 that is not retryable', async () => {
    const response = await app.request('/slime', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{intent:' });
    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.deepEqual([error.code, error.retryable], ['INVALID_REQUEST', false]);
  });
});
