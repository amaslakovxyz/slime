import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Artifact } from '@slime-cloud/core';
import { recordFromStore, sqlOf } from '@slime-cloud/core/tooling';
import { createApp } from '../src/app.js';
import { codeOfCrystal, codeOfRecord } from '../src/handler-code.js';

const connector = { safetyCheck: async () => ({ ok: true }) } as never;
const slime = { handlers: () => [] } as never;

const artifact: Artifact = {
  version: 2,
  unsatisfiable: null,
  steps: [
    { name: 'a', source: 'postgres', sql: 'SELECT 1', params: [] },
    { name: 'b', source: 'films', operation: 'list', args: [] },
    { name: 'c', source: 'postgres', sql: 'SELECT 2', params: [] },
  ],
  shapeJs: '(r) => r',
  assumptions: ['x'],
};

describe('handler code', () => {
  test('a stored record in the current form joins its SQL steps the same way sqlOf does', () => {
    const code = codeOfRecord({ key: 'k', tier: 'liquid', artifact });
    assert.deepEqual(code, { key: 'k', tier: 'liquid', sql: sqlOf(artifact), shapeJs: '(r) => r', assumptions: ['x'] });
  });

  test('a legacy stored record still yields its SQL', () => {
    const stored = { key: 'k', tier: 'gas', artifact: { unsatisfiable: null, sql: 'SELECT 3', params: [], shapeJs: null, assumptions: [] } };
    const record = recordFromStore(stored, 'postgres');
    assert.deepEqual(codeOfRecord(record), { key: 'k', tier: 'gas', sql: 'SELECT 3', assumptions: [] });
  });

  test('a Crystal', () => {
    assert.deepEqual(codeOfCrystal('k', { sql: 'SELECT 4', shape: '(r) => r' } as never), { key: 'k', tier: 'crystal', sql: 'SELECT 4', shapeJs: '(r) => r', assumptions: [] });
  });

  test('GET /v0/handlers/:key/code answers 200 or 404', async () => {
    const app = createApp({ slime, connector, handlerCode: async (key) => (key === 'k' ? { key, tier: 'gas', sql: 'SELECT 1', assumptions: [] } : undefined) });
    const ok = await app.request('/v0/handlers/k/code');
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { sql: string }).sql, 'SELECT 1');
    const missing = await app.request('/v0/handlers/nope/code');
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'HANDLER_NOT_FOUND');
  });
});
