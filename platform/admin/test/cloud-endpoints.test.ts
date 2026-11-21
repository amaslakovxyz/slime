// Cloud mode (Contract 3, cloud column) against a fake shared runtime over HTTP, a
// fake S3 bucket, the file secret store and DynamoDB Local. Skipped when DynamoDB
// Local is not reachable, unless REQUIRE_DYNAMO=1 (CI), where that is a failure.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createDevTables } from '../scripts/dev-tables';
import { check, provision, reconfigure, remove, type CheckTiming } from '../lib/cloud-endpoints';
import { ddb } from '../lib/ddb';
import { createEndpoint, endpointKey, getEndpoint, updateConnector, updateSettings, type Status } from '../lib/endpoints';
import { hasCode } from '../lib/errors';
import { secretStore } from '../lib/secrets';
import { FakeS3 } from './fake-s3';

process.env.AWS_ENDPOINT_URL_DYNAMODB ??= 'http://localhost:8000';
process.env.AWS_REGION ??= 'eu-central-1';
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'local';
process.env.SESSION_SECRET ??= 'test-secret-that-is-at-least-32-characters';
process.env.SLIME_SECRETS = 'file';
process.env.SLIME_CRYSTAL_BUCKET = 'crystals-test';

const suffix = randomBytes(4).toString('hex');
const tables = { control: `test-control-${suffix}`, handlers: `test-handlers-${suffix}` };
process.env.SLIME_CONTROL_TABLE = tables.control;
process.env.SLIME_HANDLERS_TABLE = tables.handlers;

const endpointUrl = new URL(process.env.AWS_ENDPOINT_URL_DYNAMODB);
const reachable = await new Promise<boolean>((resolve) => {
  const socket = connect(Number(endpointUrl.port || 80), endpointUrl.hostname);
  socket.setTimeout(1000);
  socket.once('connect', () => (socket.destroy(), resolve(true)));
  socket.once('timeout', () => (socket.destroy(), resolve(false)));
  socket.once('error', () => resolve(false));
});
const skip = reachable || process.env.REQUIRE_DYNAMO === '1' ? false : 'DynamoDB Local is not reachable';

const DB_URL = 'postgres://reader:pw@db.example.com:5432/app';
/** healthz polls a real HTTP server, so the retry window is real time; kept short. */
const FAST: CheckTiming = { windowMs: 300, retryMs: 25 };
const owner = (name: string) => `${name}-${suffix}@example.com`;

type Answer = { status: number; body?: string };

/** The shared runtime as the admin sees it: /ep/<id>/healthz and /ep/<id>/v0/reload, keyed by slm_. */
class FakeRuntime {
  readonly requests: string[] = [];
  /** Per endpoint id: the next healthz answers (the last one repeats); default 200. */
  readonly healthz = new Map<string, Answer[]>();
  private server: Server = createServer((req, res) => {
    const path = req.url ?? '';
    this.requests.push(`${req.method} ${path} ${req.headers['x-api-key'] ?? ''}`);
    const match = /^\/ep\/(ep-[0-9a-f]{10})\/(healthz|v0\/reload)$/.exec(path);
    if (!match) return void res.writeHead(404).end();
    if (match[2] === 'v0/reload') return void res.writeHead(204).end();
    const queue = this.healthz.get(match[1]!) ?? [];
    const answer = (queue.length > 1 ? queue.shift() : queue[0]) ?? { status: 200, body: '{"ok":true}' };
    res.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body ?? '');
  });

  async start(): Promise<string> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.close();
    await once(this.server, 'close');
  }

  /** Requests for one endpoint, without the key. */
  calls(endpointId: string): string[] {
    return this.requests.filter((r) => r.includes(`/ep/${endpointId}/`)).map((r) => r.split(' ').slice(0, 2).join(' '));
  }
}

describe('cloud endpoint flows (fake runtime, DynamoDB Local)', { skip }, () => {
  const client = new DynamoDBClient({});
  const runtime = new FakeRuntime();
  let runtimeBase: string;
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slime-cloud-'));
    process.env.SLIME_SECRETS_FILE = join(dir, 'secrets.json');
    runtimeBase = await runtime.start();
    await createDevTables(client, tables);
  });
  beforeEach(() => {
    // No trailing slash on purpose: the admin adds it, so `new URL('healthz', url)` stays under /ep/<id>/.
    process.env.SLIME_RUNTIME_URL = runtimeBase;
  });
  after(async () => {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
    for (const TableName of Object.values(tables)) await client.send(new DeleteTableCommand({ TableName })).catch(() => {});
  });

  const create = (who: string, provider = 'offline') => createEndpoint(who, { name: 'cloud', provider, databaseUrl: DB_URL });

  test('create writes provisioning with the endpoint URL and the provider secret; healthz 200 settles it ready', async () => {
    const who = owner('create');
    const id = await create(who, 'groq');
    const created = await getEndpoint(who, id);
    assert.equal(created?.status, 'provisioning');
    assert.equal(created?.url, `${runtimeBase}/ep/${id}/`);
    assert.equal(await secretStore().get(id, 'SLIME_PROVIDER'), 'groq');

    await provision(who, id, FAST);
    const ready = await getEndpoint(who, id);
    assert.equal(ready?.status, 'ready');
    assert.equal(ready?.error, undefined);
    const key = await secretStore().get(id, 'SLIME_API_KEY');
    assert.ok(runtime.requests.includes(`GET /ep/${id}/healthz ${key}`), 'healthz carries the endpoint key');
  });

  test('503 is retried until the window ends, then failed with the runtime reason capped at 300 characters', async () => {
    const who = owner('down');
    const id = await create(who);
    const message = `Database unreachable: connect ECONNREFUSED ${'x'.repeat(400)}`;
    runtime.healthz.set(id, [{ status: 503, body: JSON.stringify({ error: { code: 'NOT_READY', message } }) }]);

    await provision(who, id, FAST);
    const ep = await getEndpoint(who, id);
    assert.equal(ep?.status, 'failed');
    assert.equal(ep?.error, message.slice(0, 300));
    assert.ok(runtime.calls(id).length > 1, 'retried');
  });

  test('a cold start that answers 503 and then 200 inside the window ends ready', async () => {
    const who = owner('cold');
    const id = await create(who);
    runtime.healthz.set(id, [{ status: 503, body: 'warming' }, { status: 503, body: 'warming' }, { status: 200, body: '{"ok":true}' }]);
    // A wide window: the test ends on the 200, and a busy machine must not turn three real HTTP calls into a timeout.
    await provision(who, id, { windowMs: 5_000, retryMs: 25 });
    assert.equal((await getEndpoint(who, id))?.status, 'ready');
    assert.equal(runtime.calls(id).length, 3);
  });

  test('a status other than 5xx is final at once', async () => {
    const who = owner('refused');
    const id = await create(who);
    runtime.healthz.set(id, [{ status: 401, body: '{"error":{"code":"UNAUTHORIZED","message":"Wrong key"}}' }]);
    await provision(who, id, FAST);
    const ep = await getEndpoint(who, id);
    assert.deepEqual([ep?.status, ep?.error], ['failed', 'Wrong key']);
    assert.equal(runtime.calls(id).length, 1);
  });

  test('a runtime that does not answer fails the endpoint with that reason', async () => {
    const closed = createServer().listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const port = (closed.address() as AddressInfo).port;
    closed.close();
    await once(closed, 'close');
    process.env.SLIME_RUNTIME_URL = `http://127.0.0.1:${port}/`;
    const who = owner('nobody');
    const id = await create(who);
    await provision(who, id, FAST);
    const ep = await getEndpoint(who, id);
    assert.equal(ep?.status, 'failed');
    assert.match(ep?.error ?? '', /^Endpoint runtime did not answer/);
  });

  test('a connector change reloads the instance before the health check; a provider change that breaks it ends failed', async () => {
    const who = owner('reconf');
    const id = await create(who);
    await provision(who, id, FAST);

    assert.equal(await updateConnector(who, id, { connectorType: 'postgres', databaseUrl: `${DB_URL}?v=2` }), true);
    assert.equal((await getEndpoint(who, id))?.status, 'updating');
    const before = runtime.calls(id).length;
    await reconfigure(who, id, FAST);
    assert.deepEqual(runtime.calls(id).slice(before), [`POST /ep/${id}/v0/reload`, `GET /ep/${id}/healthz`]);
    assert.equal((await getEndpoint(who, id))?.status, 'ready');

    runtime.healthz.set(id, [{ status: 503, body: '{"error":{"code":"NOT_READY","message":"GROQ_API_KEY is not set"}}' }]);
    assert.equal(await updateSettings(who, id, { name: 'cloud', provider: 'groq' }), true);
    assert.equal(await secretStore().get(id, 'SLIME_PROVIDER'), 'groq');
    await reconfigure(who, id, FAST);
    const ep = await getEndpoint(who, id);
    assert.deepEqual([ep?.status, ep?.error, ep?.provider], ['failed', 'GROQ_API_KEY is not set', 'groq']);

    // A rename alone does not touch the runtime.
    assert.equal(await updateSettings(who, id, { name: 'renamed', provider: 'groq' }), false);
  });

  test('Retry check settles what an interrupted action left behind, and refuses a settled endpoint', async () => {
    const who = owner('retry');
    const id = await create(who);
    await check(who, id, FAST);
    assert.equal((await getEndpoint(who, id))?.status, 'ready');

    await setStatus(who, id, 'updating');
    const before = runtime.calls(id).length;
    await check(who, id, FAST);
    assert.deepEqual(runtime.calls(id).slice(before), [`POST /ep/${id}/v0/reload`, `GET /ep/${id}/healthz`]);
    assert.equal((await getEndpoint(who, id))?.status, 'ready');

    await assert.rejects(check(who, id, FAST), (err) => hasCode(err, 'NOT_UPDATABLE'));
  });

  test('a stuck provisioning endpoint can be deleted: handlers, Crystal objects, item and secrets go; usage stays', async () => {
    const who = owner('stuck');
    const id = await create(who);
    await ddb().send(new PutCommand({ TableName: tables.handlers, Item: { tenantId: id, artifactKey: 'handlers#a' } }));
    await ddb().send(new PutCommand({ TableName: tables.control, Item: { pk: `USAGE#${id}`, sk: '2026-11-21', requests: 3 } }));
    const s3 = new FakeS3();
    s3.put(`endpoints/${id}/crystal/manifest.json`);
    s3.put(`endpoints/${id}/crystal/k1.mjs`);

    await remove(who, id, { s3 });

    assert.equal(await getEndpoint(who, id), undefined);
    assert.equal(await secretStore().get(id, 'SLIME_API_KEY'), undefined);
    assert.deepEqual(s3.keys(), []);
    const handlers = await ddb().send(
      new QueryCommand({ TableName: tables.handlers, KeyConditionExpression: 'tenantId = :t', ExpressionAttributeValues: { ':t': id } }),
    );
    assert.equal(handlers.Items?.length, 0);
    const usage = await ddb().send(new GetCommand({ TableName: tables.control, Key: { pk: `USAGE#${id}`, sk: '2026-11-21' } }));
    assert.equal(usage.Item?.requests, 3);
  });

  test('a failed teardown leaves the endpoint failed with the reason, and Delete runs again', async () => {
    const who = owner('retry-delete');
    const id = await create(who);
    await provision(who, id, FAST);
    const s3 = new FakeS3();
    s3.put(`endpoints/${id}/crystal/manifest.json`);
    s3.failDeletes = true;

    await assert.rejects(remove(who, id, { s3 }), (err) => hasCode(err, 'DELETE_FAILED'));
    const failed = await getEndpoint(who, id);
    assert.deepEqual([failed?.status, failed?.error], ['failed', 'Delete failed: AccessDenied']);
    assert.ok(await secretStore().get(id, 'SLIME_API_KEY'), 'secrets stay until the teardown finishes');

    s3.failDeletes = false;
    await remove(who, id, { s3 });
    assert.equal(await getEndpoint(who, id), undefined);
  });

  test('an endpoint already deleting cannot be deleted again', async () => {
    const who = owner('twice');
    const id = await create(who);
    await setStatus(who, id, 'deleting');
    await assert.rejects(remove(who, id, { s3: new FakeS3() }), (err) => hasCode(err, 'NOT_DELETABLE'));
    assert.equal((await getEndpoint(who, id))?.status, 'deleting');
  });

  async function setStatus(who: string, id: string, status: Status) {
    await ddb().send(
      new UpdateCommand({
        TableName: tables.control,
        Key: endpointKey(who, id),
        UpdateExpression: 'SET #s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
      }),
    );
  }
});
