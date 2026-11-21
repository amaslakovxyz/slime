// The local runner's delete removes an endpoint's Liquid handlers and its
// Crystal folder, as slime-provisioner's teardown does on AWS. Runs against
// DynamoDB Local; skipped when it is not reachable, unless REQUIRE_DYNAMO=1.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createDevTables } from '../scripts/dev-tables';
import { ddb } from '../lib/ddb';
import { removeLocalEndpointData } from '../lib/local-teardown';

process.env.AWS_ENDPOINT_URL_DYNAMODB ??= 'http://localhost:8000';
process.env.AWS_REGION ??= 'eu-central-1';
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'local';

const suffix = randomBytes(4).toString('hex');
const tables = { control: `test-control-${suffix}`, handlers: `test-handlers-${suffix}` };

const endpointUrl = new URL(process.env.AWS_ENDPOINT_URL_DYNAMODB);
const reachable = await new Promise<boolean>((resolve) => {
  const socket = connect(Number(endpointUrl.port || 80), endpointUrl.hostname);
  socket.setTimeout(1000);
  socket.once('connect', () => (socket.destroy(), resolve(true)));
  socket.once('timeout', () => (socket.destroy(), resolve(false)));
  socket.once('error', () => resolve(false));
});
const skip = reachable || process.env.REQUIRE_DYNAMO === '1' ? false : 'DynamoDB Local is not reachable';

const keysOf = async (tenantId: string) =>
  (
    await ddb().send(
      new QueryCommand({
        TableName: tables.handlers,
        KeyConditionExpression: 'tenantId = :t',
        ExpressionAttributeValues: { ':t': tenantId },
      }),
    )
  ).Items ?? [];

describe('local endpoint teardown (DynamoDB Local)', { skip }, () => {
  const client = new DynamoDBClient({});
  let dataDir: string;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'slime-teardown-'));
    await createDevTables(client, tables);
  });

  after(async () => {
    await rm(dataDir, { recursive: true, force: true });
    for (const TableName of Object.values(tables)) await client.send(new DeleteTableCommand({ TableName })).catch(() => {});
  });

  test('removes every handler of the endpoint (more than one batch) and its folder, nothing else', async () => {
    const gone = 'ep-0a1b2c3d4e';
    const kept = 'ep-9f8e7d6c5b';
    for (let i = 0; i < 30; i++) {
      await ddb().send(new PutCommand({ TableName: tables.handlers, Item: { tenantId: gone, artifactKey: `handlers#${i}` } }));
    }
    await ddb().send(new PutCommand({ TableName: tables.handlers, Item: { tenantId: kept, artifactKey: 'handlers#0' } }));
    await mkdir(join(dataDir, gone, 'crystal'), { recursive: true });
    await writeFile(join(dataDir, gone, 'crystal', 'index.mjs'), 'export default {};\n');
    await mkdir(join(dataDir, kept, 'crystal'), { recursive: true });

    await removeLocalEndpointData({ endpointId: gone, handlersTable: tables.handlers, dataDir });

    assert.equal((await keysOf(gone)).length, 0);
    assert.equal((await keysOf(kept)).length, 1);
    assert.equal(existsSync(join(dataDir, gone)), false);
    assert.equal(existsSync(join(dataDir, kept)), true);
  });

  test('is a no-op when there is nothing left (a retried delete)', async () => {
    await removeLocalEndpointData({ endpointId: 'ep-00000000aa', handlersTable: tables.handlers, dataDir });
  });

  test('refuses an id that is not an endpoint id, before touching anything', async () => {
    await mkdir(join(dataDir, 'victim'), { recursive: true });
    for (const endpointId of ['../victim', 'ep-../../victim', '', 'ep-ABC']) {
      await assert.rejects(removeLocalEndpointData({ endpointId, handlersTable: tables.handlers, dataDir }), /endpoint id/);
    }
    assert.equal(existsSync(join(dataDir, 'victim')), true);
  });
});
