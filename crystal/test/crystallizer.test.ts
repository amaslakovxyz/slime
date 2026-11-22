// Crystallizer: crystallize from a running instance, with nothing configured twice.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { SlimeConfig, createSlime, handlerKeyFor, memoryStore, type Slime } from '@slime-cloud/core';
import { artifact, fakeConnector, stubGenerator } from '@slime-cloud/core/testing';
import { Crystallizer } from '../src/crystallizer.js';
import { crystallize } from '../src/crystallize.js';
import { readManifest } from '../src/manifest.js';

const ROWS = [{ name: 'Acme', cents: 1250 }];
const EUROS = { intent: 'accounts in a country with their balance in euros', output: [{ name: 'string', euros: 'number' }] };
const PLANS = { intent: 'number of accounts on each plan', output: [{ name: 'string', euros: 'number' }] };
const SHAPE = 'function shape(rows) { return rows.map((r) => ({ name: r.name, euros: r.cents / 100 })); }';
const COUNTRIES = ['DE', 'FR', 'US', 'IT', 'ES', 'NL', 'PL', 'SE', 'NO', 'FI'];

const dirs: string[] = [];
const instances: Slime[] = [];
after(async () => {
  await Promise.all(instances.map((slime) => slime.close()));
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function crystalDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slime-crystallizer-'));
  dirs.push(dir);
  return dir;
}

/** Two requests, each run ten times: Liquid after two runs (no reviewer), then eight more runs in memory only. */
async function grownSlime(): Promise<{ slime: Slime; store: ReturnType<typeof memoryStore> }> {
  const store = memoryStore();
  const generator = stubGenerator(() => artifact('SELECT name, cents FROM accounts WHERE ($1::text IS NULL OR country = $1::text)', ['country'], SHAPE));
  const slime = await createSlime(new SlimeConfig({ connector: fakeConnector({ rows: ROWS }), store, generator, tiers: { gasToLiquidRuns: 2 } }));
  instances.push(slime);
  for (const request of [EUROS, PLANS]) for (const country of COUNTRIES) await slime.query({ ...request, input: { country } });
  return { slime, store };
}

describe('Crystallizer', () => {
  test('crystallizes with the live run counts, which the store alone does not have', async () => {
    const { slime, store } = await grownSlime();
    const dir = await crystalDir();
    const fromStore = await crystallize({ connector: fakeConnector({ rows: ROWS }), store, dir, provenance: slime.provenance(), isDryRun: true });
    assert.ok(fromStore.every(({ outcome, reasons }) => outcome === 'not-ready' && /2 of 10 successful runs/.test(reasons.join())), 'the store kept the runs at promotion');

    const crystallizer = new Crystallizer(slime, { dir });
    const reports = await crystallizer.run();
    assert.deepEqual(reports.map(({ outcome }) => outcome), ['crystallized', 'crystallized']);
    assert.equal(Object.keys((await readManifest(dir)).entries).length, 2);
    assert.deepEqual(await crystallizer.check(), []);
    assert.deepEqual(await crystallizer.verify(), []);
  });

  test('crystallizes only the given keys', async () => {
    const { slime } = await grownSlime();
    const dir = await crystalDir();
    const key = handlerKeyFor({ ...EUROS, input: { country: 'DE' } });
    const reports = await new Crystallizer(slime, { dir }).run({ keys: [key] });
    assert.deepEqual(reports.map((report) => [report.key, report.outcome]), [[key, 'crystallized']]);
  });

  test('minRuns counts the live runs', async () => {
    const { slime } = await grownSlime();
    const reports = await new Crystallizer(slime, { dir: await crystalDir(), minRuns: 11 }).run({ isDryRun: true });
    assert.ok(reports.every(({ reasons }) => /10 of 11 successful runs/.test(reasons.join())));
  });

  test('waits for the instance\'s crystalReadyRuns by default, the threshold of its crystalReady event', async () => {
    const store = memoryStore();
    const generator = stubGenerator(() => artifact('SELECT name, cents FROM accounts WHERE ($1::text IS NULL OR country = $1::text)', ['country'], SHAPE));
    const slime = await createSlime(new SlimeConfig({ connector: fakeConnector({ rows: ROWS }), store, generator, tiers: { gasToLiquidRuns: 2, crystalReadyRuns: 4 } }));
    instances.push(slime);
    for (const country of COUNTRIES.slice(0, 4)) await slime.query({ ...EUROS, input: { country } });
    const reports = await new Crystallizer(slime, { dir: await crystalDir() }).run({ isDryRun: true });
    assert.deepEqual(reports.map(({ outcome }) => outcome), ['crystallized']);
  });

  test('refuses anything that is not an engine', () => {
    assert.throws(() => new Crystallizer({} as Slime, { dir: '.' }), /not a Slime instance made by createSlime\(\)/);
  });
});
