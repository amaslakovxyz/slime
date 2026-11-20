// Users and endpoints against DynamoDB Local (npm run infra:up). Skipped when it
// is not reachable, unless REQUIRE_DYNAMO=1 (CI), where that is a failure.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createDevTables } from '../scripts/dev-tables';
import { ddb } from '../lib/ddb';
import {
  createEndpoint,
  currentMonth,
  getEndpoint,
  listEndpoints,
  overview,
  requestDelete,
  revealToken,
} from '../lib/endpoints';
import { hasCode } from '../lib/errors';
import { secretPath, secretStore } from '../lib/secrets';
import { checkLogin, createUser } from '../lib/users';

process.env.AWS_ENDPOINT_URL_DYNAMODB ??= 'http://localhost:8000';
process.env.AWS_REGION ??= 'eu-central-1';
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'local';
process.env.SESSION_SECRET ??= 'test-secret-that-is-at-least-32-characters';

const suffix = randomBytes(4).toString('hex');
const tables = { control: `test-control-${suffix}`, handlers: `test-handlers-${suffix}` };
process.env.SLIME_CONTROL_TABLE = tables.control;
process.env.SLIME_HANDLERS_TABLE = tables.handlers;
process.env.SLIME_SECRETS = 'file';

const endpointUrl = new URL(process.env.AWS_ENDPOINT_URL_DYNAMODB);
const reachable = await new Promise<boolean>((resolve) => {
  const socket = connect(Number(endpointUrl.port || 80), endpointUrl.hostname);
  socket.setTimeout(1000);
  socket.once('connect', () => (socket.destroy(), resolve(true)));
  socket.once('timeout', () => (socket.destroy(), resolve(false)));
  socket.once('error', () => resolve(false));
});
const skip = reachable || process.env.REQUIRE_DYNAMO === '1' ? false : 'DynamoDB Local is not reachable';

const DB_URL = 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const email = (name: string) => `${name}-${suffix}@slime.dev`;

describe('users and endpoints (DynamoDB Local)', { skip }, () => {
  const client = new DynamoDBClient({});
  let secretsDir: string;

  before(async () => {
    secretsDir = await mkdtemp(join(tmpdir(), 'slime-admin-'));
    process.env.SLIME_SECRETS_FILE = join(secretsDir, 'secrets.json');
    await createDevTables(client, tables);
  });

  after(async () => {
    for (const TableName of [tables.control, tables.handlers]) {
      await client.send(new DeleteTableCommand({ TableName })).catch(() => {});
    }
    if (secretsDir) await rm(secretsDir, { recursive: true, force: true });
  });

  test('signup stores a lowercased user, logs in, and refuses a duplicate email', async () => {
    const address = email('Dup').toUpperCase();
    assert.equal(await createUser(address, 'password123'), address.toLowerCase());
    assert.equal(await checkLogin(address.toLowerCase(), 'password123'), true);
    assert.equal(await checkLogin(address, 'wrong-password'), false);
    await assert.rejects(createUser(address.toLowerCase(), 'password456'), (err) => hasCode(err, 'EMAIL_TAKEN'));
    await assert.rejects(createUser(email('weak'), 'short'), (err) => hasCode(err, 'WEAK_PASSWORD'));
    await assert.rejects(createUser('not-an-email', 'password123'), (err) => hasCode(err, 'INVALID_EMAIL'));
  });

  test('createEndpoint stores a pending item and both secrets', async () => {
    const owner = email('a');
    const id = await createEndpoint(owner, { name: 'shop', provider: 'offline', databaseUrl: DB_URL });
    assert.match(id, /^ep-[0-9a-f]{10}$/);

    const ep = await getEndpoint(owner, id);
    assert.equal(ep?.status, 'pending');
    assert.equal(ep?.name, 'shop');
    assert.equal(ep?.provider, 'offline');
    assert.equal(ep?.owner, owner);

    const token = await revealToken(owner, id);
    assert.ok(token?.startsWith('slm_'));
    assert.equal(ep?.tokenHint, token!.slice(-4));
    assert.equal(await secretStore().get(id, 'DATABASE_URL'), DB_URL);

    const file = process.env.SLIME_SECRETS_FILE!;
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved[secretPath(id, 'SLIME_API_KEY')], token);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  test("a user cannot see or reveal another user's endpoint", async () => {
    const a = email('owner');
    const b = email('other');
    const id = await createEndpoint(a, { name: 'private', provider: 'claude', databaseUrl: DB_URL });
    assert.deepEqual(await listEndpoints(b), []);
    assert.equal(await getEndpoint(b, id), undefined);
    assert.equal(await revealToken(b, id), undefined);
    assert.deepEqual(
      (await listEndpoints(a)).map((ep) => ep.endpointId),
      [id],
    );
  });

  test('requestDelete only moves ready or failed endpoints to deleting', async () => {
    const owner = email('delete');
    const id = await createEndpoint(owner, { name: 'gone', provider: 'groq', databaseUrl: DB_URL });
    await assert.rejects(requestDelete(owner, id), (err) => hasCode(err, 'NOT_DELETABLE'));
    assert.equal((await getEndpoint(owner, id))?.status, 'pending');

    await ddb().send(
      new UpdateCommand({
        TableName: tables.control,
        Key: { pk: `USER#${owner}`, sk: `ENDPOINT#${id}` },
        UpdateExpression: 'SET #s = :ready',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':ready': 'ready' },
      }),
    );
    await requestDelete(owner, id);
    assert.equal((await getEndpoint(owner, id))?.status, 'deleting');
    // Another user's request cannot touch it.
    await assert.rejects(requestDelete(email('intruder'), id), (err) => hasCode(err, 'NOT_DELETABLE'));
  });

  test('overview sums this month usage and Liquid handlers into an estimate', async () => {
    const owner = email('usage');
    const id = await createEndpoint(owner, { name: 'billed', provider: 'offline', databaseUrl: DB_URL });
    await ddb().send(
      new PutCommand({
        TableName: tables.control,
        Item: { pk: `USAGE#${id}`, sk: currentMonth(), requests: 2000, generations: 10, updatedAt: new Date().toISOString() },
      }),
    );
    // Last month's usage is history, not this month's bill.
    await ddb().send(
      new PutCommand({
        TableName: tables.control,
        Item: { pk: `USAGE#${id}`, sk: '2000-01', requests: 99999, generations: 999 },
      }),
    );
    for (let i = 0; i < 3; i++) {
      await ddb().send(new PutCommand({ TableName: tables.handlers, Item: { tenantId: id, artifactKey: `k${i}` } }));
    }
    await ddb().send(new PutCommand({ TableName: tables.handlers, Item: { tenantId: 'ep-someoneelse', artifactKey: 'k' } }));

    const o = await overview(owner);
    assert.equal(o.total, 1);
    assert.equal(o.byStatus.pending, 1);
    assert.equal(o.requests, 2000);
    assert.equal(o.generations, 10);
    assert.equal(o.liquidHandlers, 3);
    assert.equal(o.estimatedUsd, 1.2);
  });

  test('invalid input throws before any write', async () => {
    const owner = email('invalid');
    const readSecrets = () => readFile(process.env.SLIME_SECRETS_FILE!, 'utf8').catch(() => '');
    const before = await readSecrets();
    const cases = [
      { name: 'x', provider: 'offline', databaseUrl: 'mysql://localhost/db' },
      { name: '   ', provider: 'offline', databaseUrl: DB_URL },
      { name: 'y'.repeat(41), provider: 'offline', databaseUrl: DB_URL },
      { name: 'x', provider: 'openai', databaseUrl: DB_URL },
    ];
    for (const input of cases) {
      await assert.rejects(createEndpoint(owner, input), (err) => hasCode(err, 'INVALID'));
    }
    assert.deepEqual(await listEndpoints(owner), []);
    assert.equal(await readSecrets(), before);
  });
});
