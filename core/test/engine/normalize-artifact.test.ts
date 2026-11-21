import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { checkShapeSource } from '../../src/crystallize/allowlist.js';
import { normalizeArtifact } from '../../src/engine/normalize-artifact.js';
import type { ArtifactV2 } from '../../src/models/artifact-v2.js';
import { QuickJSRunner } from '../../src/sandbox/quickjs/quickjs-runner.js';

const runner = new QuickJSRunner();
after(() => runner.close());
const LIMITS = { timeoutMs: 1_000, memoryBytes: 32 * 1024 * 1024 };
const SHAPE = 'function shape(data, input) { const rows = []; for (const account of data.accounts) rows.push({ name: account.name, isPro: account.plan === "pro" }); return rows; }';
const SINGLE_SQL: ArtifactV2 = {
  version: 2,
  unsatisfiable: null,
  steps: [{ name: 'accounts', source: 'db', sql: 'SELECT name, plan FROM accounts', params: [] }],
  shapeJs: SHAPE,
  assumptions: ['plan names are lowercase'],
};

describe('single-SQL-step normalization (MS3)', () => {
  test('becomes a v1 artifact with the same SQL, params and assumptions', () => {
    const normalized = normalizeArtifact(SINGLE_SQL);
    assert.ok(!('version' in normalized));
    assert.deepEqual({ ...normalized, shapeJs: null }, { unsatisfiable: null, sql: 'SELECT name, plan FROM accounts', params: [], shapeJs: null, assumptions: ['plan names are lowercase'] });
  });

  test('the nested shape gives the same result as the v2 form', async () => {
    const rows = [{ name: 'Acme', plan: 'pro' }, { name: 'Globex', plan: 'free' }];
    const v2Result = await runner.run({ code: SHAPE, rows: { accounts: rows }, input: {} }, LIMITS);
    const v1Result = await runner.run({ code: normalizeArtifact(SINGLE_SQL).shapeJs ?? '', rows, input: {} }, LIMITS);
    assert.deepEqual(v1Result, v2Result);
  });

  test('the Crystal allowlist accepts the nested shape', () => {
    assert.doesNotThrow(() => checkShapeSource(normalizeArtifact(SINGLE_SQL).shapeJs ?? ''));
  });

  test('a null shapeJs stays null, and API steps or several steps stay v2', () => {
    assert.equal(normalizeArtifact({ ...SINGLE_SQL, shapeJs: null }).shapeJs, null);
    const apiOnly: ArtifactV2 = { ...SINGLE_SQL, steps: [{ name: 'films', source: 'films', operation: 'films.list', args: [] }] };
    assert.equal(normalizeArtifact(apiOnly), apiOnly);
    const twoSql: ArtifactV2 = { ...SINGLE_SQL, steps: [...SINGLE_SQL.steps, { ...SINGLE_SQL.steps[0]!, name: 'other' }] };
    assert.equal(normalizeArtifact(twoSql), twoSql);
  });
});
