import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalJSON, handlerKey, normalizeIntent, requestKey, scopeKey } from '../src/request/key.js';
import { parseRequest } from '../src/request/parse.js';

const output = [{ name: 'string', totalPaid: 'integer' }];
const key = (intent: string, input: Record<string, unknown> = {}, out: unknown = output) =>
  requestKey(parseRequest({ intent, input, output: out }));

describe('request key (R2–R4)', () => {
  test('canonical JSON ignores object key order', () => {
    assert.equal(canonicalJSON({ b: 1, a: { d: 2, c: 3 } }), canonicalJSON({ a: { c: 3, d: 2 }, b: 1 }));
  });

  test('input values never change the key', () => {
    assert.equal(key('top accounts', { limit: 5, country: 'DE' }), key('top accounts', { country: 'FR', limit: 50 }));
  });

  test('input types are not in the key either: the handler records them (R4)', () => {
    assert.equal(key('plans under a price', { maxPrice: 5 }), key('plans under a price', { maxPrice: 5.5 }));
    assert.equal(key('plans under a price', { maxPrice: 5 }), key('plans under a price', { maxPrice: '5' }));
    assert.equal(key('top accounts', { country: 'DE' }), key('top accounts', { country: null }));
  });

  test('input names are in the key: leaving a parameter out is a different request (R5)', () => {
    assert.notEqual(key('top accounts', { limit: 5 }), key('top accounts', { top: 5 }));
    assert.notEqual(key('top accounts', { limit: 5, country: null }), key('top accounts', { limit: 5 }));
  });

  test('output is in the key, but its key order is not', () => {
    assert.notEqual(key('top accounts'), key('top accounts', {}, [{ name: 'string', totalPaid: 'number' }]));
    assert.equal(key('top accounts'), key('top accounts', {}, [{ totalPaid: 'integer', name: 'string' }]));
  });

  test('intent wording is normalized for case, spacing, Unicode and trailing punctuation only (R3)', () => {
    assert.equal(normalizeIntent('  Top   Accounts. '), 'top accounts');
    assert.equal(normalizeIntent('ｔｏｐ accounts?!'), 'top accounts');
    assert.equal(key('Top accounts.'), key('top   accounts'));
    assert.notEqual(key('top accounts'), key('best accounts'));
  });

  test('is 64 hex characters', () => {
    assert.match(key('top accounts'), /^[0-9a-f]{64}$/);
  });
});

describe('handler scope and store key', () => {
  const base = { schemaHash: 's', dictionaryHash: 'd', promptHash: 'p', model: 'm' };

  test('a schema, dictionary, prompt or model change gives a new scope', () => {
    const scope = scopeKey(base);
    for (const change of [{ schemaHash: 's2' }, { dictionaryHash: 'd2' }, { promptHash: 'p2' }, { model: 'm2' }]) {
      assert.notEqual(scopeKey({ ...base, ...change }), scope, JSON.stringify(change));
    }
  });

  test('the store key starts with the scope, so one prefix lists a whole scope', () => {
    const scope = scopeKey(base);
    assert.match(scope, /^[0-9a-f]{16}$/);
    assert.ok(handlerKey(scope, 'abc').startsWith(`${scope}#`));
  });
});
