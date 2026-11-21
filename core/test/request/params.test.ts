import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SlimeError } from '../../src/shared/errors.js';
import { checkParamTypes, coarseType } from '../../src/request/params.js';

describe('parameter types (R4, R5)', () => {
  test('coarse types: whole and decimal numbers are one type; null has none', () => {
    assert.equal(coarseType(5), 'number');
    assert.equal(coarseType(5.5), 'number');
    assert.equal(coarseType('x'), 'string');
    assert.equal(coarseType(false), 'boolean');
    assert.equal(coarseType([1, 2]), 'list');
    assert.equal(coarseType(null), null);
  });

  test('the first non-null value fixes a type; later values of that type pass', () => {
    const first = checkParamTypes({}, { limit: 5, country: 'DE' });
    assert.deepEqual(first, { limit: 'number', country: 'string' });
    assert.deepEqual(checkParamTypes(first, { limit: 7.5, country: 'FR' }), first);
  });

  test('null fits any type and is how an optional filter is left empty', () => {
    const known = checkParamTypes({}, { country: 'DE' });
    assert.deepEqual(checkParamTypes(known, { country: null }), known);
  });

  test('a type first seen after nulls is learned then', () => {
    const onlyNull = checkParamTypes({}, { country: null });
    assert.deepEqual(onlyNull, { country: null });
    assert.deepEqual(checkParamTypes(onlyNull, { country: 'DE' }), { country: 'string' });
  });

  test('a value of another type is an INVALID_REQUEST listing every mismatch', () => {
    const known = checkParamTypes({}, { limit: 5, country: 'DE' });
    assert.throws(
      () => checkParamTypes(known, { limit: '5', country: ['DE'] }),
      (err: unknown) =>
        err instanceof SlimeError &&
        err.code === 'INVALID_REQUEST' &&
        /"limit" must be a number, got a string/.test(err.message) &&
        /"country" must be a string, got a list/.test(err.message),
    );
  });
});
