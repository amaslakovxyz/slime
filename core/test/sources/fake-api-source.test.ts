import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FAKE_SECRET, fakeApiSource } from '../../src/testing/fake-api-source.js';

const COLUMNS = [{ name: 'id', type: 'string', nullable: false }];
const ROWS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const options = (overrides: Partial<{ rowCap: number; signal: AbortSignal }> = {}) => ({ timeoutMs: 1_000, rowCap: 10, signal: new AbortController().signal, ...overrides });

describe('fakeApiSource', () => {
  test('describes its operations and returns rows, recording each call', async () => {
    const source = fakeApiSource({ operations: { 'items.list': { columns: COLUMNS, rows: ROWS } } });
    const schema = await source.describe({ timeoutMs: 1_000, signal: new AbortController().signal });
    assert.deepEqual(schema, { service: 'Fake API', operations: [{ name: 'items.list', params: [], columns: COLUMNS }] });
    assert.deepEqual((await source.call('items.list', { x: 1 }, options())).rows, ROWS);
    assert.deepEqual(source.calls, [{ operation: 'items.list', args: { x: 1 } }]);
  });

  test('cuts rows at rowCap and marks them truncated', async () => {
    const source = fakeApiSource({ operations: { 'items.list': { columns: COLUMNS, rows: ROWS } } });
    assert.deepEqual(await source.call('items.list', {}, options({ rowCap: 2 })), { rows: ROWS.slice(0, 2), truncated: true, ms: 0 });
  });

  test('a scripted failure carries its status and the secret', async () => {
    const source = fakeApiSource({ operations: { 'items.list': { columns: COLUMNS, rows: [], failWith: { status: 503, message: 'down' } } } });
    await assert.rejects(source.call('items.list', {}, options()), (error: Error & { status?: number }) => error.status === 503 && error.message.includes(FAKE_SECRET));
  });

  test('a gated call rejects when its signal aborts', async () => {
    const controller = new AbortController();
    const source = fakeApiSource({ operations: { 'items.list': { columns: COLUMNS, rows: ROWS, gate: new Promise(() => {}) } } });
    const pending = source.call('items.list', {}, options({ signal: controller.signal }));
    controller.abort(new Error('sibling failed'));
    await assert.rejects(pending, /sibling failed/);
  });
});
