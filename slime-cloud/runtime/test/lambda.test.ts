// Lambda runtime pieces that need no AWS: the DynamoDB store against an
// in-memory fake client, and the entry's auth and not-ready paths.
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { app, envNameFor, keyMatches } from '../src/lambda.js';
import { DynamoHandlerStore, type DocClient } from '../src/store-dynamodb.js';
import type { Artifact } from '@slime-kit/core/generator.js';
import { codeHash, type StoredHandler } from '@slime-kit/core/store.js';

/** Just enough DynamoDB: one table keyed by tenantId + artifactKey, pages of `pageSize`. */
class FakeDynamo implements DocClient {
  items = new Map<string, Record<string, any>>();
  constructor(private readonly pageSize = 100) {}

  async send(cmd: PutCommand | QueryCommand | UpdateCommand): Promise<any> {
    const input = cmd.input as any;
    if (cmd instanceof PutCommand) {
      this.items.set(`${input.Item.tenantId}|${input.Item.artifactKey}`, structuredClone(input.Item));
      return {};
    }
    if (cmd instanceof UpdateCommand) {
      const row = this.items.get(`${input.Key.tenantId}|${input.Key.artifactKey}`);
      if (!row) throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
      const v = input.ExpressionAttributeValues;
      Object.assign(row, { fixtures: v[':f'], runs: v[':r'], lastUsedAt: v[':l'] });
      return {};
    }
    const v = input.ExpressionAttributeValues;
    const all = [...this.items.values()]
      .filter((r) => r.tenantId === v[':t'])
      .sort((a, b) => a.artifactKey.localeCompare(b.artifactKey));
    const start = input.ExclusiveStartKey ? all.findIndex((r) => r.artifactKey === input.ExclusiveStartKey.artifactKey) + 1 : 0;
    const page = all.slice(start, start + this.pageSize);
    const last = start + this.pageSize < all.length ? { tenantId: v[':t'], artifactKey: page.at(-1)!.artifactKey } : undefined;
    return {
      Items: page
        .filter((r) => r.schemaHash === v[':s'] && r.promptHash === v[':p'] && r.model === v[':m'])
        .map((r) => structuredClone(r)),
      LastEvaluatedKey: last,
    };
  }
}

const artifact = (sql: string): Artifact => ({ unsatisfiable: null, sql, params: [], shapeJs: null, assumptions: [] });

function handler(key: string, scope = { schemaHash: 's1', promptHash: 'p1', model: 'm1' }): StoredHandler {
  const a = artifact('SELECT 1 AS one');
  return {
    artifactKey: key,
    fingerprint: `fp-${key}`,
    intent: 'one',
    inputSig: {},
    output: { one: 'integer' },
    artifact: a,
    codeHash: codeHash(a),
    ...scope,
    revision: 1,
    review: { status: 'approved', reviews: 1, problems: [] },
    history: [],
    fixtures: [{ input: {}, output: { one: 1 }, at: '2026-11-20T00:00:00.000Z' }],
    runs: 3,
    createdAt: '2026-11-20T00:00:00.000Z',
    promotedAt: '2026-11-20T00:00:01.000Z',
    lastUsedAt: '2026-11-20T00:00:02.000Z',
  };
}

describe('DynamoHandlerStore', () => {
  const scope = { schemaHash: 's1', promptHash: 'p1', model: 'm1' };

  test('round-trips a handler and loads only the matching scope and tenant', async () => {
    const db = new FakeDynamo();
    const store = new DynamoHandlerStore('slime-handlers', 'tenant-a', db);
    await store.saveLiquid(handler('k1'));
    await store.saveLiquid(handler('k2', { ...scope, model: 'other' }));
    await new DynamoHandlerStore('slime-handlers', 'tenant-b', db).saveLiquid(handler('k3'));

    assert.deepEqual(await store.loadLiquid(scope), [handler('k1')]);
  });

  test('follows pagination', async () => {
    const store = new DynamoHandlerStore('slime-handlers', 'tenant-a', new FakeDynamo(2));
    for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) await store.saveLiquid(handler(k));
    assert.deepEqual((await store.loadLiquid(scope)).map((h) => h.artifactKey), ['k1', 'k2', 'k3', 'k4', 'k5']);
  });

  test('updateRuns rewrites runs and fixtures, and ignores a handler that is not stored', async () => {
    const store = new DynamoHandlerStore('slime-handlers', 'tenant-a', new FakeDynamo());
    await store.saveLiquid(handler('k1'));
    const fixtures = [{ input: { a: 1 }, output: [], at: '2026-11-21T00:00:00.000Z' }];
    await store.updateRuns('k1', fixtures, 9, '2026-11-21T00:00:00.000Z');
    await store.updateRuns('missing', fixtures, 1, '2026-11-21T00:00:00.000Z');

    const [h] = await store.loadLiquid(scope);
    assert.equal(h.runs, 9);
    assert.deepEqual(h.fixtures, fixtures);
    assert.equal(h.lastUsedAt, '2026-11-21T00:00:00.000Z');
    assert.equal((await store.loadLiquid(scope)).length, 1);
  });

  test('requires a table and a tenant', () => {
    assert.throws(() => new DynamoHandlerStore('', 't', new FakeDynamo()), /table name/);
    assert.throws(() => new DynamoHandlerStore('t', '', new FakeDynamo()), /tenant id/);
  });
});

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

  test('answers 503 NOT_READY when the runtime cannot start, and retries on the next request', async () => {
    process.env.SLIME_API_KEY = 'k';
    delete process.env.SLIME_HANDLERS_TABLE;
    for (let i = 0; i < 2; i++) {
      const res = await app.request('/healthz', { headers: { 'x-api-key': 'k' } });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'NOT_READY');
      assert.match(body.error.message, /table name/);
    }
  });
});
