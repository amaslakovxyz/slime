// The euro rates source passes the ApiSource contract over recorded responses: no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeApiSourceContract, fixtureFetch } from '@slime-cloud/core/testing';
import { euroRates } from '../src/rates.mjs';

const fetchImpl = fixtureFetch(new URL('./fixtures/frankfurter/', import.meta.url));
const callOptions = () => ({ timeoutMs: 1_000, rowCap: 100, signal: new AbortController().signal });

describeApiSourceContract({
  name: 'euro rates',
  makeSource: () => euroRates({ fetchImpl }),
  cases: [{ operation: 'rates.latest', args: { currency: 'USD' }, allNullArgs: { currency: null } }],
});

test('one currency is one row: units per euro on the rate date', async () => {
  const { rows } = await euroRates({ fetchImpl }).call('rates.latest', { currency: 'USD' }, callOptions());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].currency, 'USD');
  assert.ok(rows[0].perEur > 0.5 && rows[0].perEur < 2, JSON.stringify(rows[0]));
  assert.match(rows[0].date, /^\d{4}-\d{2}-\d{2}$/);
});

test('no currency returns every currency', async () => {
  const { rows } = await euroRates({ fetchImpl }).call('rates.latest', { currency: null }, callOptions());
  assert.ok(rows.some((row) => row.currency === 'GBP') && rows.some((row) => row.currency === 'JPY'));
});
