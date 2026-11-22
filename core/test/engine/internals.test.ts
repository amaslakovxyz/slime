// slimeInternals: what build-time tools read from a running instance (core/tooling).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { SlimeConfig } from '../../src/config/slime-config.js';
import { createSlime } from '../../src/create-slime.js';
import { slimeInternals } from '../../src/engine/internals.js';
import type { Slime } from '../../src/engine/types.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import { artifact, fakeConnector, stubGenerator } from '../../src/testing/fakes.js';

const REQUEST = { intent: 'accounts in a country', input: { country: 'DE' }, output: [{ name: 'string' }] };
const instances: Slime[] = [];
after(() => Promise.all(instances.map((slime) => slime.close())));

test('exposes the instance\'s connector, store and limits, and records newer than the store', async () => {
  const connector = fakeConnector({ rows: [{ name: 'Acme' }] });
  const store = memoryStore();
  const generator = stubGenerator(() => artifact('SELECT name FROM accounts WHERE country = $1::text', ['country']));
  const slime = await createSlime(new SlimeConfig({ connector, store, generator, tiers: { gasToLiquidRuns: 2 }, limits: { rowCap: 7 } }));
  instances.push(slime);
  for (const country of ['DE', 'FR', 'US', 'IT']) await slime.query({ ...REQUEST, input: { country } });
  await slime.flush();

  const internals = slimeInternals(slime);
  assert.equal(internals.connector, connector);
  assert.equal(internals.store, store);
  assert.equal(internals.limits.rowCap, 7);
  const [live] = internals.liveRecords();
  const saved = (await store.list('handlers'))[0]?.value as { runs: number };
  assert.deepEqual([live?.tier, live?.runs, saved.runs], ['liquid', 4, 2], 'the store kept the runs at promotion');
  assert.equal(live?.fixtures.length, 4);
});

test('refuses anything that is not an engine', () => {
  assert.throws(() => slimeInternals({} as Slime), /not a Slime instance made by createSlime\(\)/);
});
