import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalJSON, changedProvenance, handlerKeyFor, normalizeIntent, requestKey } from '../src/request/key.js';
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

describe('handler provenance (§4.7)', () => {
  const saved = { schemaHash: 's', dictionaryHash: 'd', promptHash: 'p', model: 'm' };

  test('nothing changed: the handler is reused as it is', () => {
    assert.deepEqual(changedProvenance(saved, { ...saved }), []);
  });

  test('names each part that changed, in a fixed order', () => {
    assert.deepEqual(changedProvenance(saved, { ...saved, model: 'm2', schemaHash: 's2' }), ['schemaHash', 'model']);
    for (const field of ['schemaHash', 'dictionaryHash', 'promptHash', 'model'] as const) {
      assert.deepEqual(changedProvenance(saved, { ...saved, [field]: 'x' }), [field]);
    }
  });
});

describe('handlerKeyFor', () => {
  test('is the key query() stores the handler under', () => {
    assert.equal(handlerKeyFor({ intent: 'Top accounts.', input: { limit: 5 }, output }), key('top accounts', { limit: 50 }));
  });
});
