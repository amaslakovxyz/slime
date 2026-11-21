import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lintArtifact } from '../src/engine/checks/sql.js';
import { SlimeError } from '../src/shared/errors.js';
import { artifact } from './helpers.js';

function code(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SlimeError);
    return err.code;
  }
  return 'OK';
}

describe('lint of generated code', () => {
  test('passes a parameterized read', () => {
    assert.equal(code(() => lintArtifact(artifact('SELECT * FROM plans WHERE id = $1::int', ['id']), { id: 1 })), 'OK');
  });

  test('passes when a nullable parameter is null (R5)', () => {
    const a = artifact('SELECT * FROM accounts WHERE ($1::text IS NULL OR country = $1::text)', ['country']);
    assert.equal(code(() => lintArtifact(a, { country: null })), 'OK');
  });

  test('refuses writes and dangerous functions', () => {
    for (const sql of ['DELETE FROM plans', 'SELECT pg_sleep(5)', "SELECT set_config('x','y',false)", 'DROP TABLE plans']) {
      assert.equal(code(() => lintArtifact(artifact(sql), {})), 'WRITE_REFUSED', sql);
    }
  });

  test('does not mistake column names for keywords', () => {
    assert.equal(code(() => lintArtifact(artifact('SELECT created_at, updated FROM plans'), {})), 'OK');
  });

  test('requires every placeholder to map to a real, used input name', () => {
    assert.equal(code(() => lintArtifact(artifact('SELECT $1::int, $2::int', ['a']), { a: 1 })), 'INVALID_HANDLER');
    assert.equal(code(() => lintArtifact(artifact('SELECT $1::int', ['missing']), { a: 1 })), 'INVALID_HANDLER');
    assert.equal(code(() => lintArtifact(artifact('SELECT 1', ['a']), { a: 1 })), 'INVALID_HANDLER');
  });

  test('refuses input values hardcoded into the SQL or the shaping code', () => {
    const inSql = artifact("SELECT * FROM accounts WHERE country = 'Germany' AND id > $1::int", ['min']);
    assert.equal(code(() => lintArtifact(inSql, { min: 1, country: 'Germany' })), 'INVALID_HANDLER');
    const inShape = artifact('SELECT name FROM accounts', [], "function shape(rows) { return rows.filter(r => r.name !== 'Acme Corp'); }");
    assert.equal(code(() => lintArtifact(inShape, { exclude: 'Acme Corp' })), 'INVALID_HANDLER');
  });
});
