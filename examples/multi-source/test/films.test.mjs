// The Ghibli source passes the ApiSource contract over recorded responses: no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeApiSourceContract, fixtureFetch } from '@slime-cloud/core/testing';
import { ghibliFilms } from '../src/films.mjs';

const fetchImpl = fixtureFetch(new URL('./fixtures/ghibli/', import.meta.url));

describeApiSourceContract({
  name: 'ghibli films',
  makeSource: () => ghibliFilms({ fetchImpl }),
  cases: [{ operation: 'films.list', args: { director: 'Isao Takahata' }, allNullArgs: { director: null } }],
});

test('the safety check reads one film', async () => {
  const report = await ghibliFilms({ fetchImpl }).safetyCheck({ timeoutMs: 1_000, signal: new AbortController().signal });
  assert.deepEqual(report, { ok: true, user: 'Studio Ghibli API (public, read-only)', problems: [] });
});

test('numbers sent as strings become integers', async () => {
  const { rows } = await ghibliFilms({ fetchImpl }).call('films.list', { director: 'Hayao Miyazaki' }, { timeoutMs: 1_000, rowCap: 10, signal: new AbortController().signal });
  assert.ok(rows.length > 0);
  for (const row of rows) assert.ok(Number.isInteger(row.releaseYear) && Number.isInteger(row.rtScore), JSON.stringify(row));
});
