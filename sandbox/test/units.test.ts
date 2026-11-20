// Pure logic: no database, no model.
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lintArtifact } from '../src/engine.js';
import { SlimeError } from '../src/errors.js';
import {
  artifactKey,
  canonicalJSON,
  inputSignature,
  literalWarnings,
  normalizeIntent,
  requestFingerprint,
} from '../src/fingerprint.js';
import { assertValidShape, validateAgainstShape } from '../src/shape.js';
import { artifact } from './helpers.js';

describe('output shape notation', () => {
  test('accepts type names, one-element lists and objects', () => {
    assertValidShape({ plans: [{ plan: 'string', accounts: [{ name: 'string', mrr: 'number|null' }] }] });
    assertValidShape([{ id: 'integer', active: 'boolean' }]);
  });

  test('rejects unknown types, multi-element lists and empty objects', () => {
    assert.throws(() => assertValidShape({ a: 'text' }), /not a type/);
    assert.throws(() => assertValidShape(['string', 'number']), /exactly one element/);
    assert.throws(() => assertValidShape({}), /empty object/);
  });

  test('validation reports missing, extra and wrongly typed fields', () => {
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
});

describe('cache key', () => {
  const output = [{ name: 'string' }];

  test('canonical JSON ignores key order', () => {
    assert.equal(canonicalJSON({ b: 1, a: { d: 2, c: 3 } }), canonicalJSON({ a: { c: 3, d: 2 }, b: 1 }));
  });

  test('input values never change the fingerprint; key names and types do', () => {
    const fp = (input: Record<string, unknown>) => requestFingerprint('top accounts', inputSignature(input), output);
    assert.equal(fp({ limit: 5 }), fp({ limit: 10 }));
    assert.equal(fp({ a: 1, b: 'x' }), fp({ b: 'y', a: 2 }));
    assert.notEqual(fp({ limit: 5 }), fp({ limit: '5' }));
    assert.notEqual(fp({ limit: 5 }), fp({ top: 5 }));
  });

  test('intent wording is normalized for case, spacing and trailing punctuation only', () => {
    assert.equal(normalizeIntent('  Top   Accounts. '), 'top accounts');
    assert.notEqual(normalizeIntent('top accounts'), normalizeIntent('bottom accounts'));
  });

  test('schema, prompt and model changes produce a new artifact key', () => {
    const base = { fingerprint: 'f', schemaHash: 's', promptHash: 'p', model: 'm' };
    const key = artifactKey(base);
    assert.notEqual(key, artifactKey({ ...base, schemaHash: 's2' }));
    assert.notEqual(key, artifactKey({ ...base, promptHash: 'p2' }));
    assert.notEqual(key, artifactKey({ ...base, model: 'm2' }));
  });

  test('warns when values are written into the intent', () => {
    assert.equal(literalWarnings('orders for customer 4242').length, 1);
    assert.equal(literalWarnings('orders for a given customer').length, 0);
  });
});

describe('lint of generated code', () => {
  const code = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof SlimeError);
      return err.code;
    }
    return 'OK';
  };

  test('passes a parameterized read', () => {
    assert.equal(code(() => lintArtifact(artifact('SELECT * FROM plans WHERE id = $1::int', ['id']), { id: 1 })), 'OK');
  });

  test('refuses writes and dangerous functions', () => {
    for (const sql of ['DELETE FROM plans', 'SELECT pg_sleep(5)', "SELECT set_config('x','y',false)"]) {
      assert.equal(code(() => lintArtifact(artifact(sql), {})), 'WRITE_REFUSED', sql);
    }
  });

  test('does not mistake column names for keywords', () => {
    assert.equal(code(() => lintArtifact(artifact('SELECT created_at, updated FROM plans'), {})), 'OK');
  });

  test('requires every placeholder to map to a real, used input key', () => {
    assert.equal(code(() => lintArtifact(artifact('SELECT $1::int, $2::int', ['a']), { a: 1 })), 'INVALID_HANDLER');
    assert.equal(code(() => lintArtifact(artifact('SELECT $1::int', ['missing']), { a: 1 })), 'INVALID_HANDLER');
    assert.equal(code(() => lintArtifact(artifact('SELECT 1', ['a']), { a: 1 })), 'INVALID_HANDLER');
  });

  test('refuses input values hardcoded into the code', () => {
    const a = artifact("SELECT * FROM accounts WHERE country = 'Germany' AND id > $1::int", ['min']);
    assert.equal(code(() => lintArtifact(a, { min: 1, country: 'Germany' })), 'INVALID_HANDLER');
  });
});
