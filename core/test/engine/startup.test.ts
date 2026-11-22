// Startup over every source (MS8, MS16, MS17), with the P1.2 guard bypassed for core's own tests.
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { SlimeConfig, type SlimeOptions } from '../../src/config/slime-config.js';
import { createSlime } from '../../src/create-slime.js';
import type { Slime } from '../../src/engine/types.js';
import { SlimeConfigError } from '../../src/shared/errors.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import { FAKE_SECRET, fakeApiSource } from '../../src/testing/fake-api-source.js';
import { fakeConnector, fakeGenerator } from '../../src/testing/fakes.js';
import type { Source } from '../../src/sources/types.js';

const COLUMNS = [{ name: 'id', type: 'string', nullable: false }];
const instances: Slime[] = [];
after(() => Promise.all(instances.map((slime) => slime.close())));

function multiSourceConfig(sources: Record<string, Source>): SlimeConfig {
  return new SlimeConfig({ sources, store: memoryStore(), generator: fakeGenerator() } as unknown as SlimeOptions);
}

async function startupProblems(config: SlimeConfig): Promise<readonly string[]> {
  try {
    instances.push(await createSlime(config));
  } catch (error) {
    assert.ok(error instanceof SlimeConfigError, String(error));
    return error.problems;
  }
  assert.fail('expected startup to fail');
}

describe('startup with API sources (MS8)', () => {
  test('describes every API source and starts', async () => {
    const notion = fakeApiSource({ operations: { 'feedback.query': { columns: COLUMNS, rows: [] } } });
    const slime = await createSlime(multiSourceConfig({ db: fakeConnector(), notion }));
    instances.push(slime);
    assert.deepEqual(Object.keys(slime.provenance().sourceHashes ?? {}), ['db', 'notion']);
  });

  test('a failing safety check names the source, and the secret never appears', async () => {
    const problems = await startupProblems(
      multiSourceConfig({ db: fakeConnector(), notion: fakeApiSource({ operations: {}, safetyFailWith: { status: 401, message: 'unauthorized' } }) }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /^notion\.safetyCheck failed: unauthorized/);
    assert.ok(!problems.join('\n').includes(FAKE_SECRET));
  });

  test('every failing source is reported at once', async () => {
    const failing = (status: number) => fakeApiSource({ operations: {}, describeFailWith: { status, message: 'cannot read the schema' } });
    const problems = await startupProblems(multiSourceConfig({ db: fakeConnector(), notion: failing(404), films: failing(503) }));
    assert.deepEqual(problems.map((problem) => problem.split(' failed')[0]), ['notion.describe', 'films.describe']);
    assert.ok(!problems.join('\n').includes(FAKE_SECRET));
  });

  test('a SQL-only setup fails with exactly the same text as before', async () => {
    const problems = await startupProblems(new SlimeConfig({ connector: fakeConnector({ isSafe: false }), store: memoryStore(), generator: fakeGenerator() }));
    assert.deepEqual(problems, ['the user can INSERT into accounts']);
  });
});

describe('close()', () => {
  test('closes every source even when the store fails to close, then reports that failure', async () => {
    const closed: string[] = [];
    const tracked = <T extends Source>(name: string, source: T): T => ({ ...source, close: async () => void closed.push(name) });
    const store = { ...memoryStore(), close: async () => Promise.reject(new Error('store is gone')) };
    const config = new SlimeConfig({ sources: { db: tracked('db', fakeConnector()), notion: tracked('notion', fakeApiSource({ operations: {} })) }, store, generator: fakeGenerator() } as unknown as SlimeOptions);
    const slime = await createSlime(config);
    await assert.rejects(slime.close(), /store is gone/);
    assert.deepEqual(closed.sort(), ['db', 'notion']);
  });
});
