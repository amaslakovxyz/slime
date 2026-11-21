// Handlers saved before multi-source (v1 artifacts, no version field) must keep
// loading and running after every multi-source change (MS3, G6). Built by hand
// from examples/express/offline-handlers.json before any P2 code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { SlimeConfig } from '../../src/config/slime-config.js';
import { createSlime } from '../../src/create-slime.js';
import { HANDLERS_NS } from '../../src/engine/handler-cache.js';
import type { HandlerRecord, Slime } from '../../src/engine/types.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import { fakeConnector } from '../../src/testing/fakes.js';

const FIXTURES = new URL('../fixtures/v1-handlers/', import.meta.url);
const record = (file: string): HandlerRecord => JSON.parse(readFileSync(new URL(file, FIXTURES), 'utf8')) as HandlerRecord;

const instances: Slime[] = [];
after(() => Promise.all(instances.map((slime) => slime.close())));

async function lockedSlimeWith(records: HandlerRecord[], rows: Record<string, unknown>[]): Promise<Slime> {
  const store = memoryStore();
  for (const saved of records) await store.put(HANDLERS_NS, saved.key, saved);
  const slime = await createSlime(new SlimeConfig({ connector: fakeConnector({ rows }), store }));
  instances.push(slime);
  return slime;
}

describe('v1 handlers saved before multi-source (MS3)', () => {
  test('a saved handler with no input is served in locked mode', async () => {
    const slime = await lockedSlimeWith([record('plans-accounts.json')], [{ plan: 'pro', accounts: 3 }]);
    const { data, meta } = await slime.query({ intent: 'number of accounts on each plan', output: [{ plan: 'string', accounts: 'integer' }] });
    assert.deepEqual(data, [{ plan: 'pro', accounts: 3 }]);
    assert.equal(meta.tier, 'liquid');
    assert.equal(meta.handlerKey, record('plans-accounts.json').key);
  });

  test('a saved handler with a typed input is served and keeps checking the type', async () => {
    const slime = await lockedSlimeWith([record('top-accounts.json')], [{ name: 'Acme', totalPaidCents: 100 }]);
    const request = { intent: 'top N accounts by total paid invoice amount in cents, highest first', input: { limit: 5 }, output: [{ name: 'string', totalPaidCents: 'integer' }] };
    assert.deepEqual((await slime.query(request)).data, [{ name: 'Acme', totalPaidCents: 100 }]);
    await assert.rejects(slime.query({ ...request, input: { limit: 'five' } }), { code: 'INVALID_REQUEST' });
  });
});
