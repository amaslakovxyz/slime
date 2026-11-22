// Copying the sandbox runtime's Liquid handlers into the core's format (M7).
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SlimeConfig, createSlime, handlerKeyFor, type HandlerRecord } from '@slime-cloud/core';
import { migrateLegacyHandlers, toHandlerRecord, type LegacyItem } from '../src/legacy-handlers.js';
import { DynamoSlimeStore } from '../src/store-dynamodb.js';
import { FakeDynamo } from './fake-dynamo.js';

const TABLE = 'slime-handlers';
const TENANT = 'tenant-a';
const REQUEST = { intent: 'top N accounts', input: { limit: 5 }, output: [{ name: 'string' }] };
const ARTIFACT = { unsatisfiable: null, sql: 'SELECT name FROM accounts LIMIT $1::int', params: ['limit'], shapeJs: null, assumptions: [] };

function legacyItem(artifactKey: string, runs: number, inputType = 'integer'): LegacyItem & { tenantId: string } {
  const handler = {
    intent: REQUEST.intent,
    inputSig: { limit: inputType },
    output: REQUEST.output,
    artifact: ARTIFACT,
    schemaHash: 'schema',
    promptHash: 'prompt',
    model: 'claude-haiku-5-5',
    review: { status: 'approved', reviews: 1, problems: [] },
    createdAt: '2026-11-20T00:00:00.000Z',
  };
  const fixtures = [{ input: { limit: 5 }, output: [{ name: 'Acme' }], at: '2026-11-20T00:00:00.000Z' }];
  return { tenantId: TENANT, artifactKey, handler: JSON.stringify(handler), fixtures: JSON.stringify(fixtures), runs };
}

function tableWith(...items: (LegacyItem & { tenantId: string })[]): FakeDynamo {
  const client = new FakeDynamo();
  for (const item of items) client.items.set(`${item.tenantId}|${item.artifactKey}`, item);
  return client;
}

describe('legacy handler migration (M7)', () => {
  test('converts a sandbox item: request key, coarse types, inputs-only fixtures, Liquid', () => {
    const record = toHandlerRecord(legacyItem('old1', 7));
    assert.equal(record.key, handlerKeyFor(REQUEST));
    assert.deepEqual([record.tier, record.review, record.runs], ['liquid', 'approved', 7]);
    assert.deepEqual(record.paramTypes, { limit: 'number' });
    assert.deepEqual(record.fixtures, [{ limit: 5 }]);
    assert.deepEqual(record.artifact, ARTIFACT);
  });

  test('copies once, keeps the old items, and keeps the version with most runs when keys collide', async () => {
    const client = tableWith(legacyItem('old1', 3), legacyItem('old2', 9, 'number'));
    const store = new DynamoSlimeStore({ table: TABLE, tenantId: TENANT, client });
    const reports = await migrateLegacyHandlers({ client, table: TABLE, tenantId: TENANT, store });
    assert.deepEqual(reports.map(({ outcome }) => outcome).sort(), ['copied', 'superseded']);
    assert.equal(((await store.get('handlers', handlerKeyFor(REQUEST))) as HandlerRecord).runs, 9);
    assert.ok(client.items.has(`${TENANT}|old1`) && client.items.has(`${TENANT}|old2`));

    const again = await migrateLegacyHandlers({ client, table: TABLE, tenantId: TENANT, store });
    assert.ok(again.some(({ outcome }) => outcome === 'already there'));
  });

  test('a dry run writes nothing', async () => {
    const client = tableWith(legacyItem('old1', 3));
    const store = new DynamoSlimeStore({ table: TABLE, tenantId: TENANT, client });
    await migrateLegacyHandlers({ client, table: TABLE, tenantId: TENANT, store, isDryRun: true });
    assert.equal(await store.get('handlers', handlerKeyFor(REQUEST)), undefined);
  });

  test('a migrated handler is served in locked mode', async () => {
    const client = tableWith(legacyItem('old1', 3));
    const store = new DynamoSlimeStore({ table: TABLE, tenantId: TENANT, client });
    await migrateLegacyHandlers({ client, table: TABLE, tenantId: TENANT, store });
    const rows = [{ name: 'Acme' }];
    const connector = {
      kind: 'sql' as const,
      name: 'fake',
      describe: async () => ({ dialect: 'postgresql 16', tables: [] }),
      check: async () => ({ cost: 1, ms: 0 }),
      run: async () => ({ rows, truncated: false, ms: 0 }),
      safetyCheck: async () => ({ ok: true, user: 'reader', problems: [] }),
      close: async () => {},
    };
    const slime = await createSlime(new SlimeConfig({ connector, store }));
    try {
      const { data, meta } = await slime.query(REQUEST);
      assert.deepEqual(data, rows);
      assert.deepEqual([meta.tier, meta.cache], ['liquid', 'hit']);
    } finally {
      await slime.close();
    }
  });
});
