import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { codeOfRecord, codeOfCrystal } from '../src/handler-code.js';
import { createApp } from '../src/app.js';

const connector = { safetyCheck: async () => ({ ok: true }) } as never;
const slime = { handlers: () => [] } as never;

describe('handler code', () => {
  test('a stored record in the current form joins its SQL steps', () => {
    const code = codeOfRecord({ key: 'k', tier: 'liquid', artifact: { steps: [{ name: 'a', source: 'postgres', sql: 'SELECT 1', params: [] }, { name: 'b', source: 'films', operation: 'list' }, { name: 'c', source: 'postgres', sql: 'SELECT 2', params: [] }], shapeJs: '(r) => r', assumptions: ['x'] } });
    assert.deepEqual(code, { key: 'k', tier: 'liquid', sql: 'SELECT 1;\n\nSELECT 2', shapeJs: '(r) => r', assumptions: ['x'] });
  });

  test('a legacy single-query record', () => {
    assert.deepEqual(codeOfRecord({ key: 'k', tier: 'gas', artifact: { sql: 'SELECT 3' } }), { key: 'k', tier: 'gas', sql: 'SELECT 3', assumptions: [] });
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
