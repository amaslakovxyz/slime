import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { asSingleQuery, fromStoredArtifact, sqlOf, type Artifact, type LegacyArtifact } from '../../src/models/artifact.js';

const LEGACY: LegacyArtifact = {
  unsatisfiable: null,
  sql: 'SELECT name FROM plans WHERE price >= $1::int',
  params: ['minPrice'],
  shapeJs: 'function shape(rows, input) { return rows.map((r) => r.name.toUpperCase()); }',
  assumptions: ['price in cents'],
};
const ROWS = [{ name: 'basic' }, { name: 'pro' }];

function callShape(code: string, data: unknown): unknown {
  return new Function(`${code}\nreturn shape;`)()(data, {});
}

describe('reading stored artifacts', () => {
  test('a legacy single-query artifact becomes one SQL step on the given source', () => {
    const artifact = fromStoredArtifact(LEGACY, 'warehouse');
    assert.equal(artifact.version, 2);
    assert.deepEqual(artifact.steps, [{ name: 'rows', source: 'warehouse', sql: LEGACY.sql, params: ['minPrice'] }]);
    assert.deepEqual(artifact.assumptions, LEGACY.assumptions);
    assert.equal(sqlOf(artifact), LEGACY.sql);
  });

  test('its shape(rows, input) keeps working on step data', () => {
    const artifact = fromStoredArtifact(LEGACY, 'db');
    assert.deepEqual(callShape(artifact.shapeJs ?? '', { rows: ROWS }), ['BASIC', 'PRO']);
  });

  test('an unsatisfiable legacy artifact has no steps', () => {
    const artifact = fromStoredArtifact({ ...LEGACY, unsatisfiable: 'asks to delete data', sql: '', params: [] }, 'db');
    assert.deepEqual([artifact.unsatisfiable, artifact.steps], ['asks to delete data', []]);
  });

  test('a stored artifact with steps is returned as it is', () => {
    const stored: Artifact = { version: 2, unsatisfiable: null, steps: [{ name: 'a', source: 'db', sql: 'SELECT 1', params: [] }], shapeJs: null, assumptions: [] };
    assert.equal(fromStoredArtifact(stored, 'other'), stored);
  });
});

describe('the single-query view Crystal runs (C10)', () => {
  test('a one-SQL-step handler is one query with shape(rows, input)', () => {
    const query = asSingleQuery(fromStoredArtifact(LEGACY, 'db'));
    assert.equal(query?.sql, LEGACY.sql);
    assert.deepEqual(query?.params, ['minPrice']);
    assert.deepEqual(callShape(query?.shapeJs ?? '', ROWS), ['BASIC', 'PRO']);
  });

  test('handlers with API steps or several steps have none', () => {
    const sql = { name: 'a', source: 'db', sql: 'SELECT 1', params: [] };
    const api = { name: 'b', source: 'notion', operation: 'feedback.query', args: [] };
    const base = { version: 2 as const, unsatisfiable: null, shapeJs: 'function shape(data) { return data.a; }', assumptions: [] };
    assert.equal(asSingleQuery({ ...base, steps: [api] }), undefined);
    assert.equal(asSingleQuery({ ...base, steps: [sql, { ...sql, name: 'c' }] }), undefined);
  });
});
