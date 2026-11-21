import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertValidShape, validateAgainstShape, validateData } from '../../src/request/shape.js';

describe('output notation', () => {
  test('accepts type names, one-element lists and objects', () => {
    assertValidShape({ plans: [{ plan: 'string', accounts: [{ name: 'string', mrr: 'number|null' }] }] });
    assertValidShape([{ id: 'integer', active: 'boolean', since: 'date', at: 'datetime|null' }]);
  });

  test('rejects unknown types, multi-element lists, empty objects and other values', () => {
    assert.throws(() => assertValidShape({ a: 'text' }), /not a type/);
    assert.throws(() => assertValidShape(['string', 'number']), /exactly one element/);
    assert.throws(() => assertValidShape({}), /empty object/);
    assert.throws(() => assertValidShape(42), /expected a type name/);
  });

  test('rejects shapes nested too deep or with too many fields', () => {
    assert.throws(() => assertValidShape([[[[[[['string']]]]]]]), /deeper than 6/);
    const wide = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, 'string']));
    assert.throws(() => assertValidShape(wide), /more than 50 fields/);
  });
});

describe('validating data against a shape', () => {
  test('reports missing, extra and wrongly typed fields', () => {
    const shape = [{ name: 'string', count: 'integer', note: 'string|null' }];
    assert.deepEqual(validateAgainstShape(shape, [{ name: 'a', count: 2, note: null }]), []);
    const problems = validateAgainstShape(shape, [{ name: 'a', count: 2.5, extra: 1 }]);
    assert.ok(problems.some((p) => p.includes('count') && p.includes('integer')));
    assert.ok(problems.some((p) => p.includes('note') && p.includes('missing')));
    assert.ok(problems.some((p) => p.includes('extra') && p.includes('not requested')));
  });

  test('null is only allowed where the type says |null', () => {
    assert.equal(validateAgainstShape({ a: 'string' }, { a: null }).length, 1);
    assert.equal(validateAgainstShape({ a: 'string|null' }, { a: null }).length, 0);
  });

  test('date is YYYY-MM-DD and must be a real day', () => {
    assert.deepEqual(validateAgainstShape({ d: 'date' }, { d: '2026-02-28' }), []);
    assert.equal(validateAgainstShape({ d: 'date' }, { d: '2026-02-30' }).length, 1);
    assert.equal(validateAgainstShape({ d: 'date' }, { d: '2026-02-28T00:00:00Z' }).length, 1);
    assert.equal(validateAgainstShape({ d: 'date' }, { d: '28.02.2026' }).length, 1);
  });

  test('datetime is ISO 8601 with a time zone', () => {
    for (const ok of ['2026-11-20T10:00:00Z', '2026-11-20T10:00:00.123+01:00', '2026-11-20T10:00Z']) {
      assert.deepEqual(validateAgainstShape({ t: 'datetime' }, { t: ok }), [], ok);
    }
    for (const bad of ['2026-11-20T10:00:00', '2026-11-20', 'yesterday']) {
      assert.equal(validateAgainstShape({ t: 'datetime' }, { t: bad }).length, 1, bad);
    }
  });

  test('a top-level object means one row: null (no row) is fine there, but not for lists or nested objects', () => {
    assert.deepEqual(validateData({ total: 'integer' }, null), []);
    assert.equal(validateData([{ total: 'integer' }], null).length, 1);
    assert.equal(validateData({ inner: { total: 'integer' } }, { inner: null }).length, 1);
  });

  test('reports at most 10 problems', () => {
    const rows = Array.from({ length: 50 }, () => ({ n: 'x' }));
    assert.equal(validateAgainstShape([{ n: 'integer' }], rows).length, 10);
  });
});
