// The Notion adapter over hand-written fixtures (P5.4); recorded ones come in P5.5.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SlimeConfigError } from '../../../src/shared/errors.js';
import { notionSource, type NotionSourceOptions } from '../../../src/sources/notion/notion-source.js';
import type { FetchFunction } from '../../../src/sources/api/retry.js';
import { describeApiSourceContract } from '../../../src/testing/api-source-contract.js';
import { fixtureFetch } from '../../../src/testing/fixture-fetch.js';

const DATA_SOURCE = '1f2e3d4c-5b6a-4789-8abc-def012345678';
const TOKEN = 'ntn_test_token_123';
const fixtures = fixtureFetch(new URL('../../fixtures/notion-handwritten/', import.meta.url));
const options = (overrides: Partial<{ rowCap: number }> = {}) => ({ timeoutMs: 2_000, rowCap: 100, signal: new AbortController().signal, ...overrides });

function source(overrides: Partial<NotionSourceOptions> = {}) {
  return notionSource({ token: TOKEN, dataSources: { feedback: DATA_SOURCE }, comments: { feedback: { account: 'matches db.accounts.name' } }, fetchImpl: fixtures, ...overrides });
}

describeApiSourceContract({
  name: 'notion (hand-written fixtures)',
  makeSource: () => source(),
  cases: [{ operation: 'feedback.query', args: { sentiment: 'negative' }, allNullArgs: { sentiment: null } }],
});

describe('notionSource (MS12)', () => {
  test('describes the data source from its schema, with the configured comment', async () => {
    const { service, operations } = await source().describe(options());
    assert.equal(service, 'Notion API 2025-09-03 (read-only access)');
    assert.equal(operations[0]?.name, 'feedback.query');
    assert.equal(operations[0]?.columns.find((column) => column.name === 'account')?.comment, 'matches db.accounts.name');
  });

  test('follows the cursor through every page', async () => {
    const { rows, truncated } = await source().call('feedback.query', { sentiment: null }, options());
    assert.deepEqual(rows.map((row) => row.id), ['page-1', 'page-2', 'page-3']);
    assert.equal(truncated, false);
  });

  test('stops paginating at rowCap and reports truncation', async () => {
    let queries = 0;
    const counting = (async (input: string, init?: RequestInit) => ((init?.method === 'POST' && queries++), fixtures(input, init))) as FetchFunction;
    const { rows, truncated } = await source({ fetchImpl: counting }).call('feedback.query', {}, options({ rowCap: 2 }));
    assert.equal(rows.length, 2);
    assert.equal(truncated, true);
    assert.equal(queries, 1, 'the second page is never fetched');
  });

  test('a 429 is retried after Retry-After within the timeout', async () => {
    let isFirst = true;
    const flaky = (async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && isFirst) {
        isFirst = false;
        return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      }
      return fixtures(input, init);
    }) as FetchFunction;
    const { rows } = await source({ fetchImpl: flaky }).call('feedback.query', { sentiment: 'negative' }, options());
    assert.equal(rows.length, 2);
  });

  test('keeps at most 2 requests in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = (async (input: string, init?: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return fixtures(input, init);
    }) as FetchFunction;
    const sources = { a: DATA_SOURCE, b: DATA_SOURCE, c: DATA_SOURCE, d: DATA_SOURCE };
    await source({ fetchImpl: slow, dataSources: sources, comments: {} }).describe(options());
    assert.equal(maxInFlight, 2);
  });

  test('the safety check is one call and names the integration', async () => {
    assert.deepEqual(await source().safetyCheck(options()), { ok: true, user: 'Slime reader', problems: [] });
  });

  test('the token is a secret and never in an error', async () => {
    const notion = source({ fetchImpl: (async () => new Response(`bad token ${TOKEN}`, { status: 401 })) as FetchFunction });
    assert.ok(notion.secrets.includes(TOKEN));
    await assert.rejects(notion.describe(options()), (error: Error) => !error.message.includes(TOKEN));
  });

  test('refuses bad options at construction', () => {
    assert.throws(() => notionSource({ token: '', dataSources: { Feedback: 'not-an-id' } }), (error: SlimeConfigError) => error.problems.length === 3);
  });
});
