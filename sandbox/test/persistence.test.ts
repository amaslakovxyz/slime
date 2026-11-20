// Liquid handlers saved in Postgres (slime_meta, owned by slime_writer) survive restarts.
import './setup.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import { config } from '../src/config.js';
import { PostgresConnector } from '../src/connectors/postgres.js';
import { Engine } from '../src/engine.js';
import { PostgresHandlerStore } from '../src/store.js';
import {
  DB_URL,
  NO_CRYSTAL_DIR,
  META_URL,
  StubGenerator,
  TOP_ACCOUNTS,
  closeEngines,
  dbAvailable,
  makeEngine,
  withConfig,
} from './helpers.js';

const hasDb = await dbAvailable();
// Its own table: running the tests must never touch a dev server's saved handlers.
const TABLE = 'handlers_test';
const ask = (engine: Engine, limit = 5) =>
  engine.query({ intent: TOP_ACCOUNTS.intent, input: { limit }, output: TOP_ACCOUNTS.output });

async function meta<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: META_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** Promotes the TOP_ACCOUNTS handler to Liquid in a fresh engine and waits for the save. */
async function promoteOnce() {
  const engine = await makeEngine({ generator: new StubGenerator([TOP_ACCOUNTS.artifact]), store: new PostgresHandlerStore(META_URL, TABLE) });
  await ask(engine, 5);
  await engine.reviewsSettled();
  await ask(engine, 10);
  const r = await ask(engine, 3);
  assert.equal(r.meta.tier, 'liquid');
  await engine.flush();
  return r.meta.handlerId;
}

describe('Liquid persistence', { skip: !hasDb }, () => {
  beforeEach(async () => {
    const store = new PostgresHandlerStore(META_URL, TABLE);
    await store.init();
    await store.close();
    await meta(`TRUNCATE slime_meta.${TABLE}`);
  });
  afterEach(closeEngines);

  test('promotion saves the handler with its recorded runs', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      const id = await promoteOnce();
      const rows = await meta<{ tier: string; runs: string; fixtures: unknown[] }>(
        `SELECT tier, runs, fixtures FROM slime_meta.${TABLE} WHERE artifact_key = $1`,
        [id],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tier, 'liquid');
      assert.equal(Number(rows[0].runs), 3);
      assert.equal(rows[0].fixtures.length, 3, 'three distinct inputs were recorded');
    });
  });

  test('a restarted engine serves saved Liquid handlers without generating', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      await promoteOnce();
      const generator = new StubGenerator([() => assert.fail('must not generate')]);
      const engine = await makeEngine({ generator, store: new PostgresHandlerStore(META_URL, TABLE) });
      assert.equal(engine.stats().store.loadedOnStart, 1);
      const r = await ask(engine, 4);
      assert.equal(r.meta.cache, 'hit');
      assert.equal(r.meta.tier, 'liquid');
      assert.equal((r.data as unknown[]).length, 4);
      assert.equal(generator.calls, 0);
    });
  });

  test('a locked server serves what an explore server saved', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      await promoteOnce();
      await withConfig({ mode: 'locked' }, async () => {
        const connector = new PostgresConnector(DB_URL);
        const engine = await Engine.create(connector, { store: new PostgresHandlerStore(META_URL, TABLE), crystalDir: NO_CRYSTAL_DIR });
        try {
          assert.equal((await ask(engine)).meta.tier, 'liquid');
        } finally {
          await engine.close();
          await connector.close();
        }
      });
    });
  });

  test('a saved handler whose code was edited is refused', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      const id = await promoteOnce();
      await meta(
        `UPDATE slime_meta.${TABLE} SET artifact = jsonb_set(artifact, '{sql}', to_jsonb('SELECT 1'::text)) WHERE artifact_key = $1`,
        [id],
      );
      const generator = new StubGenerator([TOP_ACCOUNTS.artifact]);
      const engine = await makeEngine({ generator, store: new PostgresHandlerStore(META_URL, TABLE) });
      assert.equal(engine.stats().store.refusedOnStart, 1);
      assert.equal((await ask(engine)).meta.cache, 'miss');
      assert.equal(generator.calls, 1);
    });
  });

  test('handlers saved under another model are not reused', async () => {
    await withConfig({ gasToLiquidHits: 3 }, async () => {
      await promoteOnce();
      await withConfig({ model: 'some-other-model' }, async () => {
        const engine = await makeEngine({ store: new PostgresHandlerStore(META_URL, TABLE) });
        assert.equal(engine.stats().store.loadedOnStart, 0);
      });
      assert.equal(config.model, 'offline');
    });
  });

  test('the saved run count keeps up after the recorded-run cap is reached', async () => {
    await withConfig({ gasToLiquidHits: 3, fixturesPerHandler: 3 }, async () => {
      const id = await promoteOnce();
      const engine = await makeEngine({ store: new PostgresHandlerStore(META_URL, TABLE) });
      for (const limit of [5, 5, 10, 3]) await ask(engine, limit); // repeats: no new recorded runs
      await engine.flush();
      const rows = await meta<{ runs: string }>(`SELECT runs FROM slime_meta.${TABLE} WHERE artifact_key = $1`, [id]);
      assert.equal(Number(rows[0].runs), 7, 'three runs before the restart, four after');
    });
  });

  test('recorded runs keep growing after promotion, up to the cap', async () => {
    await withConfig({ gasToLiquidHits: 3, fixturesPerHandler: 4 }, async () => {
      const id = await promoteOnce();
      const engine = await makeEngine({ store: new PostgresHandlerStore(META_URL, TABLE) });
      await ask(engine, 6);
      await ask(engine, 7);
      await engine.flush();
      const rows = await meta<{ fixtures: { input: { limit: number } }[] }>(
        `SELECT fixtures FROM slime_meta.${TABLE} WHERE artifact_key = $1`,
        [id],
      );
      assert.deepEqual(rows[0].fixtures.map((f) => f.input.limit), [5, 10, 3, 6]);
    });
  });
});
