// The DynamoDB SlimeStore: the core's own store contract, plus what this table adds.
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeStoreContract } from '@slime-cloud/core/testing';
import { DynamoSlimeStore } from '../src/store-dynamodb.js';
import { FakeDynamo } from './fake-dynamo.js';

const TABLE = 'slime-handlers';

describeStoreContract('DynamoDB', () => new DynamoSlimeStore({ table: TABLE, tenantId: 'tenant-a', client: new FakeDynamo() }));
describeStoreContract('DynamoDB, one item per page', () => new DynamoSlimeStore({ table: TABLE, tenantId: 'tenant-a', client: new FakeDynamo(1) }));

describe('DynamoSlimeStore on the existing table', () => {
  test('keeps tenants apart: each one is its own partition', async () => {
    const client = new FakeDynamo();
    await new DynamoSlimeStore({ table: TABLE, tenantId: 'tenant-a', client }).put('handlers', 'k1', 'a');
    const otherTenant = new DynamoSlimeStore({ table: TABLE, tenantId: 'tenant-b', client });
    assert.equal(await otherTenant.get('handlers', 'k1'), undefined);
    assert.deepEqual(await otherTenant.list('handlers'), []);
  });

  test('never lists items the sandbox runtime wrote, so a rollback still finds them untouched', async () => {
    const client = new FakeDynamo();
    client.items.set('tenant-a|abc123', { tenantId: 'tenant-a', artifactKey: 'abc123', handler: '{}', fixtures: '[]', runs: 3 });
    const store = new DynamoSlimeStore({ table: TABLE, tenantId: 'tenant-a', client });
    assert.deepEqual(await store.list('handlers'), []);
    assert.ok(client.items.has('tenant-a|abc123'));
  });

  test('page() reads one namespace of one tenant by key range, one item per page included', async () => {
    const client = new FakeDynamo(1);
    const store = new DynamoSlimeStore({ table: TABLE, tenantId: 'tenant-a', client });
    for (const key of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) await store.put('events', key, { key });
    await store.put('handlers', 'zzz', 'not an event');
    await store.put('crystal', '2026-01-05', 'not an event either');
    await new DynamoSlimeStore({ table: TABLE, tenantId: 'tenant-b', client }).put('events', '2026-01-09', 'another tenant');
    const keys = (page: { entries: { key: string }[] }) => page.entries.map(({ key }) => key);

    const first = await store.page('events', { limit: 2 });
    assert.deepEqual([keys(first), first.hasOlder, first.hasNewer], [['2026-01-04', '2026-01-03'], true, false]);
    const older = await store.page('events', { limit: 2, before: '2026-01-03' });
    assert.deepEqual([keys(older), older.hasOlder, older.hasNewer], [['2026-01-02', '2026-01-01'], false, true]);
    const newer = await store.page('events', { limit: 2, after: '2026-01-02' });
    assert.deepEqual([keys(newer), newer.hasOlder, newer.hasNewer], [['2026-01-04', '2026-01-03'], true, false]);
  });

  test('requires a table and a tenant', () => {
    assert.throws(() => new DynamoSlimeStore({ table: '', tenantId: 't', client: new FakeDynamo() }), /table name/);
    assert.throws(() => new DynamoSlimeStore({ table: TABLE, tenantId: '', client: new FakeDynamo() }), /tenant id/);
  });
});
