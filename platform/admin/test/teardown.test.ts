// The shared endpoint teardown. Locally: handlers, Crystal folder, control item, secrets.
// In the cloud: secrets first (revoking the endpoint on the shared runtime), then handlers,
// every S3 version, control item.
// Runs against DynamoDB Local; skipped when it is not reachable, unless REQUIRE_DYNAMO=1.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createDevTables } from '../scripts/dev-tables';
import { ddb } from '../lib/ddb';
import { endpointKey } from '../lib/endpoints';
import { secretStore, type SecretStore } from '../lib/secrets';
import { removeEndpoint } from '../lib/teardown';
import { FakeS3 } from './fake-s3';

process.env.AWS_ENDPOINT_URL_DYNAMODB ??= 'http://localhost:8000';
process.env.AWS_REGION ??= 'eu-central-1';
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'local';
process.env.SESSION_SECRET ??= 'test-secret-that-is-at-least-32-characters';
process.env.SLIME_SECRETS = 'file';

const suffix = randomBytes(4).toString('hex');
const tables = { control: `test-control-${suffix}`, handlers: `test-handlers-${suffix}` };
process.env.SLIME_CONTROL_TABLE = tables.control;

const endpointUrl = new URL(process.env.AWS_ENDPOINT_URL_DYNAMODB);
const reachable = await new Promise<boolean>((resolve) => {
  const socket = connect(Number(endpointUrl.port || 80), endpointUrl.hostname);
  socket.setTimeout(1000);
  socket.once('connect', () => (socket.destroy(), resolve(true)));
  socket.once('timeout', () => (socket.destroy(), resolve(false)));
  socket.once('error', () => resolve(false));
});
const skip = reachable || process.env.REQUIRE_DYNAMO === '1' ? false : 'DynamoDB Local is not reachable';

const OWNER = `owner-${suffix}@example.com`;
const handlerCount = async (tenantId: string) =>
  (
    await ddb().send(
      new QueryCommand({ TableName: tables.handlers, KeyConditionExpression: 'tenantId = :t', ExpressionAttributeValues: { ':t': tenantId } }),
    )
  ).Items?.length ?? 0;
const controlItem = async (endpointId: string) =>
  (await ddb().send(new GetCommand({ TableName: tables.control, Key: endpointKey(OWNER, endpointId) }))).Item;

/** An endpoint with 30 handlers (two batches), a control item and both secrets. */
async function seed(endpointId: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await ddb().send(new PutCommand({ TableName: tables.handlers, Item: { tenantId: endpointId, artifactKey: `handlers#${i}` } }));
  }
  await ddb().send(new PutCommand({ TableName: tables.control, Item: { ...endpointKey(OWNER, endpointId), type: 'endpoint', endpointId } }));
  await secretStore().put(endpointId, 'SLIME_API_KEY', `slm_${endpointId}`, { overwrite: true });
  await secretStore().put(endpointId, 'DATABASE_URL', 'postgres://r:r@db/app', { overwrite: true });
}

describe('shared endpoint teardown (DynamoDB Local)', { skip }, () => {
  const client = new DynamoDBClient({});
  let dir: string;
  let dataDir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slime-teardown-'));
    process.env.SLIME_SECRETS_FILE = join(dir, 'secrets.json');
    await createDevTables(client, tables);
  });
  beforeEach(async () => {
    dataDir = await mkdtemp(join(dir, 'data-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
    for (const TableName of Object.values(tables)) await client.send(new DeleteTableCommand({ TableName })).catch(() => {});
  });

  test('locally: removes the handlers, the Crystal folder, the item and the secrets of that endpoint only', async () => {
    const [gone, kept] = ['ep-0a1b2c3d4e', 'ep-9f8e7d6c5b'];
    await seed(gone);
    await seed(kept);
    await mkdir(join(dataDir, gone, 'crystal'), { recursive: true });
    await writeFile(join(dataDir, gone, 'crystal', 'index.mjs'), 'export default {};\n');
    await mkdir(join(dataDir, kept, 'crystal'), { recursive: true });

    await removeEndpoint({ endpointId: gone, owner: OWNER, handlersTable: tables.handlers, crystals: { kind: 'dir', dataDir }, secrets: secretStore() });

    assert.equal(await handlerCount(gone), 0);
    assert.equal(existsSync(join(dataDir, gone)), false);
    assert.equal(await controlItem(gone), undefined);
    assert.equal(await secretStore().get(gone, 'SLIME_API_KEY'), undefined);
    assert.equal(await handlerCount(kept), 30);
    assert.equal(existsSync(join(dataDir, kept)), true);
    assert.ok(await controlItem(kept));
    assert.equal(await secretStore().get(kept, 'SLIME_API_KEY'), `slm_${kept}`);
  });

  test('in the cloud: removes the secrets first, then the handlers, every version and delete marker under the prefix, then the item', async () => {
    const [gone, kept] = ['ep-1a1b2c3d4e', 'ep-1f8e7d6c5b'];
    await seed(gone);
    await seed(kept);
    const s3 = new FakeS3();
    for (const key of ['manifest.json', 'manifest.json', 'k1.mjs', 'k2.mjs']) s3.put(`endpoints/${gone}/crystal/${key}`);
    s3.put(`endpoints/${gone}/crystal/old.mjs`, true);
    s3.put(`endpoints/${kept}/crystal/manifest.json`);
    s3.put(`artifacts/admin.zip`);

    const seen: string[] = [];
    s3.onCall = async (name) => {
      if (name === 'ListObjectVersions' && !seen.some((line) => line.startsWith('s3 starts'))) {
        seen.push(`s3 starts: handlers=${await handlerCount(gone)} item=${Boolean(await controlItem(gone))}`);
      }
    };
    const files = secretStore();
    const secrets: SecretStore = {
      put: files.put.bind(files),
      get: files.get.bind(files),
      removeAll: async (id) => {
        seen.push(`secrets: handlers=${await handlerCount(id)} item=${Boolean(await controlItem(id))} objects=${s3.keys(`endpoints/${id}/`).length}`);
        await files.removeAll(id);
      },
    };

    await removeEndpoint({ endpointId: gone, owner: OWNER, handlersTable: tables.handlers, crystals: { kind: 's3', bucket: 'b', client: s3 }, secrets });

    assert.deepEqual(seen, ['secrets: handlers=30 item=true objects=5', 's3 starts: handlers=0 item=true']);
    assert.deepEqual(s3.keys(`endpoints/${gone}/`), []);
    assert.deepEqual(s3.keys(), [`endpoints/${kept}/crystal/manifest.json@v6`, 'artifacts/admin.zip@v7']);
    assert.equal(await secretStore().get(gone, 'DATABASE_URL'), undefined);
    assert.equal(await handlerCount(kept), 30);
  });

  test('a failed Crystal delete has already revoked the secrets and keeps the item, so the teardown can run again', async () => {
    const id = 'ep-2a1b2c3d4e';
    await seed(id);
    const s3 = new FakeS3();
    s3.put(`endpoints/${id}/crystal/manifest.json`);
    s3.failDeletes = true;
    const run = () =>
      removeEndpoint({ endpointId: id, owner: OWNER, handlersTable: tables.handlers, crystals: { kind: 's3', bucket: 'b', client: s3 }, secrets: secretStore() });

    await assert.rejects(run(), /AccessDenied/);
    assert.ok(await controlItem(id));
    // The shared runtime stops serving the endpoint once its SSM path is gone.
    assert.equal(await secretStore().get(id, 'SLIME_API_KEY'), undefined);

    s3.failDeletes = false;
    await run();
    assert.equal(await controlItem(id), undefined);
    assert.deepEqual(s3.keys(), []);
  });

  test('is a no-op when there is nothing left (a retried delete)', async () => {
    await removeEndpoint({
      endpointId: 'ep-00000000aa',
      owner: OWNER,
      handlersTable: tables.handlers,
      crystals: { kind: 's3', bucket: 'b', client: new FakeS3() },
      secrets: secretStore(),
    });
  });

  test('refuses an id that is not an endpoint id, before touching anything', async () => {
    await mkdir(join(dataDir, 'victim'), { recursive: true });
    const s3 = new FakeS3();
    s3.put('endpoints/victim');
    for (const endpointId of ['../victim', 'ep-../../victim', '', 'ep-ABCDEF0123', 'ep-0a1b2c3d4', 'ep-0a1b2c3d4e/']) {
      for (const crystals of [{ kind: 'dir', dataDir } as const, { kind: 's3', bucket: 'b', client: s3 } as const]) {
        await assert.rejects(
          removeEndpoint({ endpointId, owner: OWNER, handlersTable: tables.handlers, crystals, secrets: secretStore() }),
          /endpoint id/,
        );
      }
    }
    assert.equal(existsSync(join(dataDir, 'victim')), true);
    assert.deepEqual(s3.calls, []);
  });
});
