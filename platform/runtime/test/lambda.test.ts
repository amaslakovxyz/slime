// The Lambda entry and the env config, with no AWS and no database.
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { slimeConfigFromEnv } from '../src/config.js';
import { app, envNameFor, keyMatches } from '../src/lambda.js';

const BASE_ENV = { SLIME_HANDLERS_TABLE: 'slime-handlers', SLIME_TENANT_ID: 'tenant-a', SLIME_PROVIDER: 'offline' };

describe('Lambda entry', () => {
  test('keyMatches needs both keys and an exact match', () => {
    assert.equal(keyMatches('secret', 'secret'), true);
    assert.equal(keyMatches('secret', 'Secret'), false);
    assert.equal(keyMatches(undefined, 'secret'), false);
    assert.equal(keyMatches('secret', undefined), false);
    assert.equal(keyMatches('', ''), false);
  });

  test('SSM parameter names map to their last path segment', () => {
    assert.equal(envNameFor('/slime/runtime/DATABASE_URL'), 'DATABASE_URL');
  });

  test('refuses requests without the API key, and with no key configured at all', async () => {
    delete process.env.SLIME_API_KEY;
    assert.equal((await app.request('/healthz', { headers: { 'x-api-key': '' } })).status, 401);
    process.env.SLIME_API_KEY = 'k';
    assert.equal((await app.request('/healthz')).status, 401);
    assert.equal((await app.request('/healthz', { headers: { 'x-api-key': 'wrong' } })).status, 401);
  });

  test("a Crystal token gets past auth only on that Crystal's route", async () => {
    process.env.SLIME_API_KEY = 'k';
    process.env.CRYSTAL_TOKENS = JSON.stringify({ abc: 'slc_abc' });
    delete process.env.SLIME_HANDLERS_TABLE;
    const as = (path: string, method = 'POST') => app.request(path, { method, headers: { 'x-api-key': 'slc_abc' }, body: method === 'POST' ? '{}' : undefined });
    assert.equal((await as('/v0/query')).status, 401);
    assert.equal((await as('/healthz', 'GET')).status, 401);
    assert.equal((await as('/v0/e/other')).status, 401);
    // Past auth, the (unconfigured) runtime answers 503: the token was accepted.
    assert.equal((await as('/v0/e/abc')).status, 503);
    delete process.env.CRYSTAL_TOKENS;
  });

  test('answers 503 NOT_READY when the runtime cannot start, and retries on the next request', async () => {
    process.env.SLIME_API_KEY = 'k';
    delete process.env.SLIME_HANDLERS_TABLE;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.request('/healthz', { headers: { 'x-api-key': 'k' } });
      assert.equal(response.status, 503);
      const body = (await response.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'NOT_READY');
      assert.match(body.error.message, /table name/);
    }
  });
});

describe('config from env (the sandbox variable names)', () => {
  test('SLIME_MODE=locked means no generator', async () => {
    const config = await slimeConfigFromEnv({ ...BASE_ENV, SLIME_MODE: 'locked' });
    assert.equal(config.mode, 'locked');
    await config.connector.close();
  });

  test('the offline provider explores with the bundled handlers, without a reviewer', async () => {
    const config = await slimeConfigFromEnv(BASE_ENV);
    assert.deepEqual([config.mode, config.generator?.model, config.reviewer], ['explore', 'offline', undefined]);
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
    assert.deepEqual([withReview.generator?.model, withReview.reviewer?.model], ['claude-haiku-5-5', 'claude-opus-5-5']);
    assert.equal(withoutReview.reviewer, undefined);
    await Promise.all([withReview.connector.close(), withoutReview.connector.close()]);
  });
});
