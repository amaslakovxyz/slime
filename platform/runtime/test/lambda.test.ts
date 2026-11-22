// The deployed Lambda app and the env config, with no AWS and no database.
// The router and tenant cache with fakes are in tenants.test.ts.
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SlimeConfigError, type CrystalRegistry } from '@slime-cloud/core';
import { keyMatches } from '../src/auth.js';
import { cannedGenerator } from '@slime-cloud/core/testing';
import { slimeConfigFromEnv } from '../src/config.js';
import { app } from '../src/lambda.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://reader:reader@localhost:1/none',
  SLIME_HANDLERS_TABLE: 'slime-handlers',
  SLIME_TENANT_ID: 'ep-0123456789',
  SLIME_PROVIDER: 'groq',
  GROQ_API_KEY: 'test',
};

describe('Lambda entry', () => {
  test('keyMatches needs both keys and an exact match', () => {
    assert.equal(keyMatches('secret', 'secret'), true);
    assert.equal(keyMatches('secret', 'Secret'), false);
    assert.equal(keyMatches(undefined, 'secret'), false);
    assert.equal(keyMatches('secret', undefined), false);
    assert.equal(keyMatches('', ''), false);
  });

  test('every path outside /ep/<id>/ is 401, root /healthz included, whatever key is sent', async () => {
    for (const path of ['/healthz', '/', '/v0/query', '/epx/ep-0123456789/healthz']) {
      const response = await app.request(path, { headers: { 'x-api-key': 'anything' } });
      assert.equal(response.status, 401, path);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'UNAUTHORIZED');
    }
  });
});

describe('config from env (the sandbox variable names)', () => {
  test('a missing or empty DATABASE_URL is a config error naming it, never a fallback database', async () => {
    for (const DATABASE_URL of [undefined, '']) {
      await assert.rejects(slimeConfigFromEnv({ ...BASE_ENV, DATABASE_URL }), (error: unknown) => {
        assert.ok(error instanceof SlimeConfigError);
        assert.deepEqual(error.problems, ['DATABASE_URL is not set']);
        return true;
      });
    }
  });

  test('SLIME_PROVIDER=groq generates and reviews with Groq', async () => {
    const config = await slimeConfigFromEnv(BASE_ENV);
    assert.deepEqual([config.generator.model, config.reviewer?.model], ['openai/gpt-oss-120b', 'openai/gpt-oss-120b']);
    await config.connector.close();
  });

  test('a generator passed in (tests) replaces the provider, with no reviewer', async () => {
    const generator = cannedGenerator({});
    const config = await slimeConfigFromEnv(BASE_ENV, { generator });
    assert.deepEqual([config.generator, config.reviewer], [generator, undefined]);
    await config.connector.close();
  });

  test('limits and tiers come from their variables; unset ones keep the core defaults', async () => {
    const config = await slimeConfigFromEnv({ ...BASE_ENV, MAX_GENERATIONS_PER_HOUR: '50', GAS_TO_LIQUID_HITS: '5', SHAPE_MEMORY_MB: '16', ROW_CAP: '' });
    assert.deepEqual(
      [config.limits.maxGenerationsPerHour, config.tiers.gasToLiquidRuns, config.limits.shapeMemoryBytes, config.limits.rowCap],
      [50, 5, 16 * 1024 * 1024, 1_000],
    );
    await config.connector.close();
  });

  test('claude is the default provider, with a reviewer unless SLIME_REVIEW=off', async () => {
    const withReview = await slimeConfigFromEnv({ ...BASE_ENV, SLIME_PROVIDER: '', ANTHROPIC_API_KEY: 'test' });
    const withoutReview = await slimeConfigFromEnv({ ...BASE_ENV, SLIME_PROVIDER: '', ANTHROPIC_API_KEY: 'test', SLIME_REVIEW: 'off' });
    assert.deepEqual([withReview.generator?.model, withReview.reviewer?.model], ['claude-haiku-5-5', 'claude-sonnet-5-5']);
    assert.equal(withoutReview.reviewer, undefined);
    await Promise.all([withReview.connector.close(), withoutReview.connector.close()]);
  });

  test('the Crystals the store loaded are served unless SLIME_CRYSTAL=off', async () => {
    const crystal = { k1: { intent: 'i' } } as unknown as CrystalRegistry;
    const served = await slimeConfigFromEnv(BASE_ENV, { crystal });
    const switchedOff = await slimeConfigFromEnv({ ...BASE_ENV, SLIME_CRYSTAL: 'off' }, { crystal });
    assert.deepEqual(Object.keys(served.crystal || {}), ['k1']);
    assert.equal(switchedOff.crystal, false);
    await Promise.all([served.connector.close(), switchedOff.connector.close()]);
  });
});
