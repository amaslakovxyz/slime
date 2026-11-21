import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SlimeError } from '../src/shared/errors.js';
import { literalsInIntent, parseRequest } from '../src/request/parse.js';

const output = [{ name: 'string' }];

function invalid(raw: unknown): string {
  try {
    parseRequest(raw);
  } catch (err) {
    assert.ok(err instanceof SlimeError);
    assert.equal(err.code, 'INVALID_REQUEST');
    assert.equal(err.status, 400);
    return err.message;
  }
  assert.fail('expected INVALID_REQUEST');
}

describe('request fields (§4.1)', () => {
  test('intent and output are required; input defaults to {}', () => {
    assert.deepEqual(parseRequest({ intent: 'top accounts', output }), { intent: 'top accounts', input: {}, output });
    assert.match(invalid({ output }), /"intent"/);
    assert.match(invalid({ intent: '   ', output }), /"intent"/);
    assert.match(invalid({ intent: 'x' }), /"output".*required/);
  });

  test('unknown fields are refused, so a typo is not silently ignored', () => {
    assert.match(invalid({ intent: 'x', output, outpt: {} }), /Unknown request field "outpt"/);
  });

  test('the request and input must be plain objects', () => {
    assert.match(invalid(null), /must be an object/);
    assert.match(invalid([]), /must be an object/);
    assert.match(invalid({ intent: 'x', input: [1], output }), /"input" must be an object/);
  });

  test('intent is at most 500 characters', () => {
    assert.match(invalid({ intent: 'x'.repeat(501), output }), /at most 500/);
  });

  test('input names are identifiers and values are scalars or lists of scalars', () => {
    parseRequest({ intent: 'x', input: { a: 'x', b: 1.5, c: true, d: null, e: [1, 'two', null] }, output });
    assert.match(invalid({ intent: 'x', input: { 'bad-name': 1 }, output }), /not valid/);
    assert.match(invalid({ intent: 'x', input: { a: { nested: 1 } }, output }), /string, number, boolean, null/);
    assert.match(invalid({ intent: 'x', input: { a: [[1]] }, output }), /string, number, boolean, null/);
    assert.match(invalid({ intent: 'x', input: { a: Number.NaN }, output }), /string, number, boolean, null/);
  });

  test('input has at most 20 keys', () => {
    const input = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    assert.match(invalid({ intent: 'x', input, output }), /at most 20 keys/);
  });

  test('limit and offset are reserved: non-negative integers or null (R6)', () => {
    parseRequest({ intent: 'x', input: { limit: 10, offset: 0 }, output });
    parseRequest({ intent: 'x', input: { limit: null }, output });
    for (const bad of [-1, 2.5, '10']) {
      assert.match(invalid({ intent: 'x', input: { limit: bad }, output }), /reserved for paging/, String(bad));
    }
    assert.match(invalid({ intent: 'x', input: { offset: -5 }, output }), /reserved for paging/);
  });

  test('an invalid output shape is an INVALID_REQUEST', () => {
    assert.match(invalid({ intent: 'x', output: { a: 'text' } }), /Invalid output shape/);
  });
});

describe('literal values in the intent (R7)', () => {
  test('finds numbers, quoted text, emails and UUIDs', () => {
    assert.deepEqual(literalsInIntent('orders for customer 4242'), ['a number']);
    assert.deepEqual(literalsInIntent("accounts in 'Germany'"), ['quoted text']);
    assert.deepEqual(literalsInIntent('invoices of bob@example.com'), ['an email address']);
    assert.deepEqual(literalsInIntent('account 123e4567-e89b-12d3-a456-426614174000'), ['a number', 'a UUID']);
  });

  test('a plain description has none', () => {
    assert.deepEqual(literalsInIntent('top N accounts by total paid amount, highest first'), []);
  });
});
