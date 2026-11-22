// Handlers saved before multi-source (v1 artifacts, no version field) must keep
// loading and running after every multi-source change (MS3, G6). Built by hand
// from examples/express/offline-handlers.json before any P2 code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { SlimeConfig } from '../../src/config/slime-config.js';
import { createSlime } from '../../src/create-slime.js';
import { HANDLERS_NS } from '../../src/handler/record.js';
import type { Slime } from '../../src/engine/types.js';
import type { HandlerRecord } from '../../src/handler/record.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import { fakeConnector, stubGenerator } from '../../src/testing/fakes.js';

const FIXTURES = new URL('../fixtures/v1-handlers/', import.meta.url);
const record = (file: string): HandlerRecord => JSON.parse(readFileSync(new URL(file, FIXTURES), 'utf8')) as HandlerRecord;

const instances: Slime[] = [];
after(() => Promise.all(instances.map((slime) => slime.close())));

// The stub fails if called: these requests must be answered by the saved handlers.
const neverCalled = stubGenerator(() => {
  throw new Error('a saved handler should have answered');
});

/** Saves the records with today's provenance, as if this instance had made them. */
async function slimeServing(records: HandlerRecord[], rows: Record<string, unknown>[]): Promise<Slime> {
  const store = memoryStore();
  const config = new SlimeConfig({ connector: fakeConnector({ rows }), store, generator: neverCalled });
  const probe = await createSlime(config);
  const provenance = probe.provenance();
  await probe.close();
  for (const saved of records) await store.put(HANDLERS_NS, saved.key, { ...saved, provenance });
  const slime = await createSlime(config.with({ connector: fakeConnector({ rows }) }));
  instances.push(slime);
  return slime;
}

describe('v1 handlers saved before multi-source (MS3)', () => {
  test('a saved handler with no input is served', async () => {
    const slime = await slimeServing([record('plans-accounts.json')], [{ plan: 'pro', accounts: 3 }]);
    const { data, meta } = await slime.query({ intent: 'number of accounts on each plan', output: [{ plan: 'string', accounts: 'integer' }] });
    assert.deepEqual(data, [{ plan: 'pro', accounts: 3 }]);
    assert.equal(meta.tier, 'liquid');
    assert.equal(meta.handlerKey, record('plans-accounts.json').key);
  });

  test('a saved handler with a typed input is served and keeps checking the type', async () => {
    const slime = await slimeServing([record('top-accounts.json')], [{ name: 'Acme', totalPaidCents: 100 }]);
    const request = { intent: 'top N accounts by total paid invoice amount in cents, highest first', input: { limit: 5 }, output: [{ name: 'string', totalPaidCents: 'integer' }] };
    assert.deepEqual((await slime.query(request)).data, [{ name: 'Acme', totalPaidCents: 100 }]);
    await assert.rejects(slime.query({ ...request, input: { limit: 'five' } }), { code: 'INVALID_REQUEST' });
  });
});
