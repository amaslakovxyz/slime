import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertPlainRows } from '../../../src/sources/api/plain-rows.js';

const ORIGIN = { stepName: 'feedback', sourceName: 'notion' };

describe('API rows are plain JSON (S4)', () => {
  test('accepts strings, numbers, booleans, null and nested objects', () => {
    assert.doesNotThrow(() => assertPlainRows([{ a: 'x', b: 1, c: true, d: null, e: { f: [1, 'g'] } }], ORIGIN));
  });

  test('refuses a bigint, a function and undefined', () => {
    for (const value of [10n, () => 1, undefined]) {
      assert.throws(() => assertPlainRows([{ id: 'a', value }], ORIGIN), { code: 'SOURCE_ERROR', message: new RegExp(`returned a ${typeof value} value`) });
    }
  });
});
