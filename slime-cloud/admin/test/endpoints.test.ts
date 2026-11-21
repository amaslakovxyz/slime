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
  endpointStats,
  getEndpoint,
  listEndpoints,
  overview,
  requestDelete,
  revealToken,
  updateConnector,
  updateSettings,
  type Status,
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

    await setStatus(owner, id, 'ready');
    await requestDelete(owner, id);
    assert.equal((await getEndpoint(owner, id))?.status, 'deleting');
    // Another user's request cannot touch it.
    await assert.rejects(requestDelete(email('intruder'), id), (err) => hasCode(err, 'NOT_DELETABLE'));
  });

  test('endpointStats sums a month of day items into tier totals, a daily series and an estimate', async () => {
    const owner = email('stats');
    const id = await createEndpoint(owner, { name: 'billed', provider: 'offline', databaseUrl: DB_URL });
    const day = (sk: string, item: Record<string, unknown>) =>
      ddb().send(new PutCommand({ TableName: tables.control, Item: { pk: `USAGE#${id}`, sk, ...item } }));
    await day('2025-03-02', {
      requests: 1950, generations: 5,
      gasRequests: 50, liquidRequests: 500, crystalRequests: 1400,
      gasMs: 10000, liquidMs: 2250, crystalMs: 700,
      inputTokens: 10000, outputTokens: 2500, gasHandlers: 3, crystalHandlers: 4,
    });
    await day('2025-03-01', {
      requests: 1000, generations: 10,
      gasRequests: 100, liquidRequests: 300, crystalRequests: 600,
      gasMs: 25000, liquidMs: 1200, crystalMs: 300,
      inputTokens: 20000, outputTokens: 5000, gasHandlers: 5, crystalHandlers: 2,
    });
    // A later day without snapshots must not erase the last reported ones.
    await day('2025-03-03', { updatedAt: '2025-03-03T10:00:00Z' });
    // Other months, and a v1 monthly item, are not part of March.
    await day('2025-04-01', { requests: 99999, gasRequests: 99999, generations: 999 });
    await day('2025-03', { requests: 2000, generations: 10 });
    for (let i = 0; i < 3; i++) {
      await ddb().send(new PutCommand({ TableName: tables.handlers, Item: { tenantId: id, artifactKey: `k${i}` } }));
    }
    await ddb().send(new PutCommand({ TableName: tables.handlers, Item: { tenantId: 'ep-someoneelse', artifactKey: 'k' } }));

    const s = await endpointStats(id, '2025-03');
    assert.equal(s.requests, 2950);
    assert.equal(s.generations, 15);
    assert.deepEqual(
      [s.tiers.gas.requests, s.tiers.liquid.requests, s.tiers.crystal.requests],
      [150, 800, 2000],
    );
    assert.equal(s.tiers.gas.avgMs?.toFixed(2), '233.33');
    assert.equal(s.tiers.liquid.avgMs, 4.3125);
    assert.equal(s.tiers.crystal.avgMs, 0.5);
    assert.deepEqual([s.inputTokens, s.outputTokens], [30000, 7500]);
    assert.deepEqual([s.gasHandlers, s.crystalHandlers, s.liquidHandlers], [3, 4, 3]);
    assert.equal(s.daily.length, 31);
    assert.deepEqual(s.daily[0], { day: '2025-03-01', gas: 100, liquid: 300, crystal: 600 });
    assert.deepEqual(s.daily[2], { day: '2025-03-03', gas: 0, liquid: 0, crystal: 0 });
    assert.deepEqual(s.daily[30], { day: '2025-03-31', gas: 0, liquid: 0, crystal: 0 });
    // 150 Gas ($0.30) + 800 Liquid ($0.40) + 2000 Crystal ($0.20) + 15 generations ($0.30).
    assert.equal(s.estimatedUsd, 1.2);
    // All 2950 as Gas would be $5.90 + $0.30.
    assert.equal(s.savingsUsd, 5);

    const empty = await endpointStats(id, '2025-05');
    assert.equal(empty.requests, 0);
    assert.equal(empty.tiers.gas.avgMs, null);
    assert.equal(empty.gasHandlers, null);
    assert.equal(empty.estimatedUsd, 0);
  });

  test('overview adds up endpoints for the current month, day by day', async () => {
    const owner = email('overview');
    const today = new Date().toISOString().slice(0, 10);
    const a = await createEndpoint(owner, { name: 'a', provider: 'offline', databaseUrl: DB_URL });
    const b = await createEndpoint(owner, { name: 'b', provider: 'offline', databaseUrl: DB_URL });
    await setStatus(owner, b, 'updating');
    const usage = { requests: 1000, generations: 2, gasRequests: 100, liquidRequests: 400, crystalRequests: 500, gasMs: 20000 };
    for (const id of [a, b]) {
      await ddb().send(new PutCommand({ TableName: tables.control, Item: { pk: `USAGE#${id}`, sk: today, ...usage } }));
    }
    await ddb().send(new PutCommand({ TableName: tables.handlers, Item: { tenantId: a, artifactKey: 'k' } }));

    const o = await overview(owner);
    assert.equal(o.total, 2);
    assert.equal(o.byStatus.pending, 1);
    assert.equal(o.byStatus.updating, 1);
    assert.equal(o.requests, 2000);
    assert.equal(o.tiers.gas.avgMs, 200);
    assert.equal(o.liquidHandlers, 1);
    assert.deepEqual(o.daily.at(-1), { day: today, gas: 200, liquid: 800, crystal: 1000 });
    // 200 Gas ($0.40) + 800 Liquid ($0.40) + 1000 Crystal ($0.10) + 4 generations ($0.08).
    assert.equal(o.estimatedUsd, 0.98);
  });

  test('updateConnector overwrites the secret, and redeploys only a ready or failed endpoint', async () => {
    const owner = email('connector');
    const id = await createEndpoint(owner, { name: 'conn', provider: 'offline', databaseUrl: DB_URL });
    const url = (n: number) => `postgres://reader:pw${n}@db.example.com:5432/app`;
    const stored = () => secretStore().get(id, 'DATABASE_URL');

    await updateConnector(owner, id, { connectorType: 'postgres', databaseUrl: url(1) });
    assert.equal(await stored(), url(1));
    assert.equal((await getEndpoint(owner, id))?.status, 'pending');

    await setStatus(owner, id, 'ready');
    await updateConnector(owner, id, { connectorType: 'postgres', databaseUrl: url(2) });
    assert.equal(await stored(), url(2));
    const updating = await getEndpoint(owner, id);
    assert.equal(updating?.status, 'updating');
    assert.equal(updating?.connectorType, 'postgres');

    for (const status of ['updating', 'provisioning', 'deleting'] as const) {
      await setStatus(owner, id, status);
      await assert.rejects(updateConnector(owner, id, { connectorType: 'postgres', databaseUrl: url(3) }), (err) =>
        hasCode(err, 'NOT_UPDATABLE'),
      );
      assert.equal(await stored(), url(2));
    }

    await setStatus(owner, id, 'failed');
    await assert.rejects(updateConnector(owner, id, { connectorType: 'postgres', databaseUrl: 'mysql://x/y' }), (err) =>
      hasCode(err, 'INVALID'),
    );
    await assert.rejects(updateConnector(owner, id, { connectorType: 'mysql', databaseUrl: url(4) }), (err) =>
      hasCode(err, 'INVALID'),
    );
    await assert.rejects(updateConnector(email('stranger'), id, { connectorType: 'postgres', databaseUrl: url(4) }), (err) =>
      hasCode(err, 'NOT_FOUND'),
    );
    assert.equal(await stored(), url(2));
    assert.equal((await getEndpoint(owner, id))?.status, 'failed');
  });

  test('updateSettings renames in place; a provider change needs ready or failed and redeploys', async () => {
    const owner = email('settings');
    const id = await createEndpoint(owner, { name: 'before', provider: 'offline', databaseUrl: DB_URL });

    await updateSettings(owner, id, { name: 'renamed', provider: 'offline' });
    let ep = await getEndpoint(owner, id);
    assert.deepEqual([ep?.name, ep?.status], ['renamed', 'pending']);

    await assert.rejects(updateSettings(owner, id, { name: 'renamed', provider: 'claude' }), (err) =>
      hasCode(err, 'NOT_UPDATABLE'),
    );
    assert.equal((await getEndpoint(owner, id))?.provider, 'offline');

    await setStatus(owner, id, 'ready');
    await updateSettings(owner, id, { name: 'switched', provider: 'groq' });
    ep = await getEndpoint(owner, id);
    assert.deepEqual([ep?.name, ep?.provider, ep?.status], ['switched', 'groq', 'updating']);

    await setStatus(owner, id, 'deleting');
    await assert.rejects(updateSettings(owner, id, { name: 'late', provider: 'groq' }), (err) =>
      hasCode(err, 'NOT_UPDATABLE'),
    );
    assert.equal((await getEndpoint(owner, id))?.name, 'switched');
    await assert.rejects(updateSettings(owner, id, { name: '', provider: 'groq' }), (err) => hasCode(err, 'INVALID'));
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
      { name: 'x', provider: 'offline', databaseUrl: DB_URL, connectorType: 'clickhouse' },
    ];
    for (const input of cases) {
      await assert.rejects(createEndpoint(owner, input), (err) => hasCode(err, 'INVALID'));
    }
    assert.deepEqual(await listEndpoints(owner), []);
    assert.equal(await readSecrets(), before);
  });

  async function setStatus(owner: string, id: string, status: Status) {
    await ddb().send(
      new UpdateCommand({
        TableName: tables.control,
        Key: { pk: `USER#${owner}`, sk: `ENDPOINT#${id}` },
        UpdateExpression: 'SET #s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
      }),
    );
  }
});
