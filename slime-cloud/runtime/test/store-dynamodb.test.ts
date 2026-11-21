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

  test('requires a table and a tenant', () => {
    assert.throws(() => new DynamoSlimeStore({ table: '', tenantId: 't', client: new FakeDynamo() }), /table name/);
    assert.throws(() => new DynamoSlimeStore({ table: TABLE, tenantId: '', client: new FakeDynamo() }), /tenant id/);
  });
});
