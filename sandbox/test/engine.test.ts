// The engine end to end against the demo Postgres, with stub generators and
// reviewers instead of a model.
import './setup.js';
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { SlimeError } from '../src/errors.js';
import { Engine } from '../src/engine.js';
import { PostgresConnector } from '../src/connectors/postgres.js';
import { MemoryHandlerStore } from '../src/store.js';
import {
  DB_URL,
  NO_CRYSTAL_DIR,
  StubGenerator,
  StubReviewer,
  TOP_ACCOUNTS,
  artifact,
  closeEngines,
  dbAvailable,
  makeEngine,
  withConfig,
} from './helpers.js';

const hasDb = await dbAvailable();
const reviewsDone = (engine: Engine) => engine.reviewsSettled();
const errorCode = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof SlimeError ? e.code : `not a SlimeError: ${e}`),
  );
const ask = (engine: Engine, input: Record<string, unknown> = { limit: 5 }) =>
  engine.query({ intent: TOP_ACCOUNTS.intent, input, output: TOP_ACCOUNTS.output });

describe('engine', { skip: !hasDb }, () => {
  afterEach(closeEngines);

  test('a miss generates once; repeats and other values reuse the code', async () => {
    const generator = new StubGenerator([TOP_ACCOUNTS.artifact]);
    const engine = await makeEngine({ generator });

    const first = await ask(engine, { limit: 5 });
    assert.equal(first.meta.cache, 'miss');
    assert.equal(first.meta.tier, 'gas');
    assert.equal((first.data as unknown[]).length, 5);

    const again = await ask(engine, { limit: 5 });
    assert.equal(again.meta.cache, 'hit');
    assert.deepEqual(again.data, first.data);

    const more = await ask(engine, { limit: 10 });
    assert.equal(more.meta.cache, 'hit');
    assert.equal((more.data as unknown[]).length, 10);
    assert.equal(generator.calls, 1);
  });

  test('never sends input values to the generator', async () => {
    const generator = new StubGenerator([TOP_ACCOUNTS.artifact]);
    const engine = await makeEngine({ generator });
    await ask(engine, { limit: 7 });
    const sent = JSON.stringify(generator.requests[0]);
    assert.ok(sent.includes('"limit":"integer"'));
    assert.ok(!sent.includes('7'));
  });

  test('identical requests arriving together share one generation', async () => {
    const generator = new StubGenerator([TOP_ACCOUNTS.artifact], 150);
    const engine = await makeEngine({ generator });
    const results = await Promise.all([ask(engine), ask(engine), ask(engine)]);
    assert.equal(generator.calls, 1);
    assert.deepEqual(results.map((r) => r.meta.cache).sort(), ['coalesced', 'coalesced', 'miss']);
  });

  test('a failing first attempt gets the error back and one repair', async () => {
    const broken = artifact(TOP_ACCOUNTS.artifact.sql.replace('amount_cents', 'amount_cent'), ['limit']);
    const generator = new StubGenerator([broken, TOP_ACCOUNTS.artifact]);
    const engine = await makeEngine({ generator });
    const r = await ask(engine);
    assert.equal(r.meta.generation?.attempts, 2);
    assert.match(generator.requests[1].previous?.error ?? '', /amount_cent/);
  });

  test('gives up after the repair budget and caches nothing', async () => {
    const generator = new StubGenerator([artifact('SELECT nope FROM plans')]);
    const engine = await makeEngine({ generator });
    assert.equal(await errorCode(ask(engine)), 'QUERY_ERROR');
    assert.equal(generator.calls, 2);
    await errorCode(ask(engine));
    assert.equal(generator.calls, 4, 'a failed generation must not be cached');
  });

  test('a result that does not match the requested shape is never cached', async () => {
    const generator = new StubGenerator([artifact('SELECT name FROM plans LIMIT $1::int', ['limit'])]);
    const engine = await makeEngine({ generator });
    assert.equal(await errorCode(ask(engine)), 'SHAPE_MISMATCH');
    assert.equal(engine.listHandlers().length, 0);
  });

  test('a request to change data is refused and not cached', async () => {
    const generator = new StubGenerator([{ ...artifact(''), unsatisfiable: 'This request asks to delete data.' }]);
    const engine = await makeEngine({ generator });
    const req = { intent: 'delete all canceled subscriptions', input: {}, output: { deleted: 'integer' } };
    assert.equal(await errorCode(engine.query(req)), 'WRITE_REFUSED');
    assert.equal(engine.listHandlers().length, 0);
  });

  test('locked mode serves nothing it has not seen and never loads a generator', async () => {
    await withConfig({ mode: 'locked' }, async () => {
      const connector = new PostgresConnector(DB_URL);
      const engine = await Engine.create(connector, { store: new MemoryHandlerStore(), crystalDir: NO_CRYSTAL_DIR });
      try {
        assert.equal(engine.stats().model, null);
        assert.equal(await errorCode(ask(engine)), 'HANDLER_NOT_FOUND');
      } finally {
        await engine.close();
        await connector.close();
      }
    });
  });

  describe('tiers', () => {
    test('Gas becomes Liquid after N successful runs and an approved review', async () => {
      await withConfig({ gasToLiquidHits: 3 }, async () => {
        const engine = await makeEngine({ generator: new StubGenerator([TOP_ACCOUNTS.artifact]) });
        assert.equal((await ask(engine)).meta.tier, 'gas');
        await reviewsDone(engine);
        assert.equal((await ask(engine)).meta.tier, 'gas');
        assert.equal((await ask(engine)).meta.tier, 'liquid');
      });
    });

    test('runs that fail do not count toward promotion', async () => {
      await withConfig({ gasToLiquidHits: 2 }, async () => {
        const engine = await makeEngine({ generator: new StubGenerator([TOP_ACCOUNTS.artifact]) });
        await ask(engine);
        await reviewsDone(engine);
        // A value Postgres can't cast fails at run time.
        assert.notEqual(await errorCode(ask(engine, { limit: 'many' as unknown as number })), 'OK');
        assert.equal(engine.listHandlers()[0].tier, 'gas');
        assert.equal((await ask(engine)).meta.tier, 'liquid');
      });
    });

    test('a popular handler without an approved review stays Gas and warns', async () => {
      await withConfig({ gasToLiquidHits: 2, maxReviews: 2 }, async () => {
        const engine = await makeEngine({
          generator: new StubGenerator([TOP_ACCOUNTS.artifact]),
          reviewer: new StubReviewer(['reject']),
        });
        await ask(engine);
        await reviewsDone(engine);
        const r = await ask(engine);
        assert.equal(r.meta.tier, 'gas');
        assert.equal(r.meta.review.status, 'rejected');
        assert.ok(r.meta.warnings.some((w) => w.includes('background review found problems')));
        assert.equal(r.meta.review.revision, 1, 'one revision was tried between the two reviews');
      });
    });

    test('a rejected handler is replaced by its revision once that is approved', async () => {
      await withConfig({ gasToLiquidHits: 2 }, async () => {
        const revised = artifact(TOP_ACCOUNTS.artifact.sql.replace('DESC', 'DESC, a.name'), ['limit']);
        const engine = await makeEngine({
          generator: new StubGenerator([TOP_ACCOUNTS.artifact, revised]),
          reviewer: new StubReviewer(['reject', 'approve']),
        });
        await ask(engine);
        await reviewsDone(engine);
        const h = engine.listHandlers()[0];
        assert.equal(h.review.status, 'approved');
        assert.equal(h.revision, 1);
        assert.equal(h.sql, revised.sql);
        assert.equal(h.runs, 1, 'runs earned by the old code do not carry over');
        assert.equal((await ask(engine)).meta.tier, 'liquid');
      });
    });

    test('a review call that fails is retried on the next request', async () => {
      await withConfig({ gasToLiquidHits: 2 }, async () => {
        const reviewer = new StubReviewer(['error', 'approve']);
        const engine = await makeEngine({ generator: new StubGenerator([TOP_ACCOUNTS.artifact]), reviewer });
        await ask(engine);
        await reviewsDone(engine);
        assert.equal(engine.listHandlers()[0].review.status, 'failed');
        await ask(engine);
        await reviewsDone(engine);
        assert.equal(reviewer.calls, 2);
        assert.equal(engine.listHandlers()[0].review.status, 'approved');
        assert.equal((await ask(engine)).meta.tier, 'liquid');
      });
    });

    test('Gas that is not promoted in time evaporates', async () => {
      await withConfig({ gasWindowMs: 50, gasToLiquidHits: 100 }, async () => {
        const generator = new StubGenerator([TOP_ACCOUNTS.artifact]);
        const engine = await makeEngine({ generator });
        await ask(engine);
        await new Promise((r) => setTimeout(r, 80));
        assert.equal((await ask(engine)).meta.cache, 'miss');
        assert.equal(generator.calls, 2);
      });
    });
  });
});
