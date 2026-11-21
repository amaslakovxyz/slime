// Local stand-in for slime-provisioner: runs each endpoint as a runtime process
// on localhost (platform/runtime/src/local.ts) instead of a Lambda. Talks to the
// admin only through slime-control, with the same state machine:
//   pending  -> start, health check -> ready (+ url) | failed (+ error)
//   updating -> restart (loads new Crystal modules)  -> ready | failed
//   deleting -> stop, remove handlers, Crystal folder, the item, then secrets
//   ready but not running (runner restarted)         -> start again, new url
// Refuses to run without AWS_ENDPOINT_URL_DYNAMODB so it never touches real AWS.
// The model key (ANTHROPIC_API_KEY or GROQ_API_KEY) comes from this process's
// environment and is passed to the children; nothing here reads it.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { DeleteCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/ddb';
import { env } from '../lib/env';
import { removeLocalEndpointData } from '../lib/local-teardown';
import { startupFailure } from '../lib/runtime-output';
import { secretStore } from '../lib/secrets';

const RUNTIME_DIR = resolve(import.meta.dirname, '../../runtime');
const DATA_DIR = resolve(import.meta.dirname, '../.data/endpoints');
const handlersTable = () => process.env.SLIME_HANDLERS_TABLE || 'slime-handlers';
const POLL_MS = 2000;
const HEALTH_TIMEOUT_MS = 20_000;
const FIRST_PORT = 8700;

interface Item {
  pk: string;
  sk: string;
  endpointId: string;
  provider: string;
  status: string;
  url?: string;
}

interface Running {
  child: ChildProcess;
  port: number;
  stderr: string[];
}

const running = new Map<string, Running>();
/** Each endpoint keeps its port for the runner's lifetime, so its URL survives restarts (the agent holds it). */
const ports = new Map<string, number>();
const busy = new Set<string>();

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ runner: msg, ...extra }));

const isFree = (port: number) =>
  new Promise<boolean>((done) => {
    const s = createServer().once('error', () => done(false));
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
  });

const portFromUrl = (url: string | undefined): number | undefined => {
  const port = url ? Number(new URL(url).port) : NaN;
  return Number.isInteger(port) && port > 0 ? port : undefined;
};

/**
 * The endpoint's own port when it has one (waiting briefly for the old process to release it);
 * else a port no other endpoint holds. A busy own port is an error, never a silent move: the
 * agent holds the URL, and a new port would quietly break it.
 */
async function portFor(endpointId: string, previous: number | undefined): Promise<number> {
  const own = ports.get(endpointId) ?? previous;
  if (own !== undefined) {
    for (let i = 0; i < 20; i++) {
      if (await isFree(own)) return own;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Port ${own} is busy (another process holds it); free it so the endpoint keeps its URL`);
  }
  for (let port = FIRST_PORT; port < FIRST_PORT + 200; port++) {
    if ([...ports.entries()].some(([id, held]) => id !== endpointId && held === port)) continue;
    // Claim before awaiting: endpoints started in the same tick must not both pick this port.
    ports.set(endpointId, port);
    if (await isFree(port)) return port;
    ports.delete(endpointId);
  }
  throw new Error('No free port');
}

async function start(item: Item): Promise<string> {
  const secrets = secretStore();
  const [databaseUrl, apiKey, crystalTokens] = await Promise.all([
    secrets.get(item.endpointId, 'DATABASE_URL'),
    secrets.get(item.endpointId, 'SLIME_API_KEY'),
    secrets.get(item.endpointId, 'CRYSTAL_TOKENS'),
  ]);
  if (!databaseUrl || !apiKey) throw new Error('Endpoint secrets are missing');
  const port = await portFor(item.endpointId, portFromUrl(item.url));
  ports.set(item.endpointId, port);
  const crystalDir = resolve(DATA_DIR, item.endpointId, 'crystal');
  mkdirSync(crystalDir, { recursive: true });

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/local.ts'], {
    cwd: RUNTIME_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      SLIME_API_KEY: apiKey,
      CRYSTAL_TOKENS: crystalTokens ?? '',
      SLIME_PROVIDER: item.provider,
      SLIME_TENANT_ID: item.endpointId,
      SLIME_HANDLERS_TABLE: handlersTable(),
      // Usage counters live in the control table, as with provisioned Lambdas.
      SLIME_USAGE_TABLE: env().controlTable,
      SLIME_CRYSTAL_DIR: crystalDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entry: Running = { child, port, stderr: [] };
  const keep = (chunk: Buffer) => {
    entry.stderr.push(...chunk.toString().split('\n').filter(Boolean));
    entry.stderr.splice(0, Math.max(0, entry.stderr.length - 20));
  };
  child.stderr?.on('data', keep);
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[${item.endpointId}] ${chunk}`));
  child.on('exit', (code) => {
    if (running.get(item.endpointId) === entry) running.delete(item.endpointId);
    log('exited', { endpointId: item.endpointId, code });
  });
  running.set(item.endpointId, entry);

  const url = `http://localhost:${port}/`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${url}healthz`, { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(2000) });
      if (res.ok) return url;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop(item.endpointId);
  throw new Error(`Health check failed: ${startupFailure(entry.stderr)}`);
}

function stop(endpointId: string): Promise<void> {
  const entry = running.get(endpointId);
  if (!entry) return Promise.resolve();
  running.delete(endpointId);
  return new Promise((done) => {
    entry.child.once('exit', () => done());
    entry.child.kill('SIGTERM');
    setTimeout(() => {
      entry.child.kill('SIGKILL');
      done();
    }, 3000).unref();
  });
}

async function setStatus(item: Item, status: 'ready' | 'failed', extra: { url?: string; error?: string }): Promise<void> {
  const names: Record<string, string> = { '#s': 'status' };
  const values: Record<string, unknown> = { ':s': status, ':now': new Date().toISOString(), ':from': item.status };
  let set = 'SET #s = :s, updatedAt = :now';
  if (extra.url) {
    set += ', #u = :u';
    names['#u'] = 'url';
    values[':u'] = extra.url;
  }
  if (extra.error) {
    set += ', #e = :e';
    names['#e'] = 'error';
    values[':e'] = extra.error.slice(0, 500);
  }
  const remove = status === 'ready' ? ' REMOVE #e' : '';
  if (remove) names['#e'] = 'error';
  await ddb().send(
    new UpdateCommand({
      TableName: env().controlTable,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: set + remove,
      // Only move the item from the state we acted on; the admin may have changed it meanwhile.
      ConditionExpression: '#s = :from',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

const foreign = new Set<string>();

/** DynamoDB Local may be shared with another checkout: act only on endpoints whose secrets this admin holds. */
async function isOurs(endpointId: string): Promise<boolean> {
  if (foreign.has(endpointId)) return false;
  if (await secretStore().get(endpointId, 'SLIME_API_KEY')) return true;
  foreign.add(endpointId);
  log('skipped (secrets belong to another admin)', { endpointId });
  return false;
}

async function handle(item: Item): Promise<void> {
  const id = item.endpointId;
  // Every item may belong to another checkout's runner (shared DynamoDB Local): a child we run, or
  // secrets we hold, is the only proof it is ours. Only this runner removes secrets, and it deletes
  // the item first, so an endpoint of ours never loses its secrets while its item still exists.
  if (!running.has(id) && !(await isOurs(id))) return;
  if (item.status === 'pending' || item.status === 'updating' || (item.status === 'ready' && !running.has(id))) {
    await stop(id);
    try {
      const url = await start(item);
      await setStatus(item, 'ready', { url });
      log('ready', { endpointId: id, url, was: item.status });
    } catch (err) {
      await setStatus(item, 'failed', { error: (err as Error).message }).catch(() => {});
      log('failed', { endpointId: id, error: (err as Error).message });
    }
  } else if (item.status === 'deleting') {
    await stop(id);
    ports.delete(id);
    // Handlers and the Crystal folder before the item: if this fails, the item stays
    // `deleting` and the next tick retries (still ours: the secrets are kept until the end).
    await removeLocalEndpointData({ endpointId: id, handlersTable: handlersTable(), dataDir: DATA_DIR });
    // Item first, secrets last: if removing secrets fails, the item is already gone, so the
    // next tick does not treat a half-deleted endpoint as "not ours" and leave it stuck.
    await ddb().send(new DeleteCommand({ TableName: env().controlTable, Key: { pk: item.pk, sk: item.sk } }));
    await secretStore().removeAll(id);
    log('deleted', { endpointId: id });
  }
}

async function tick(): Promise<void> {
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb().send(
      new ScanCommand({
        TableName: env().controlTable,
        FilterExpression: '#t = :endpoint',
        ExpressionAttributeNames: { '#t': 'type' },
        ExpressionAttributeValues: { ':endpoint': 'endpoint' },
        ExclusiveStartKey,
      }),
    );
    for (const raw of page.Items ?? []) {
      const item = raw as Item;
      // Reserve every port already in a URL (ours or not), so no other endpoint takes it.
      const known = portFromUrl(item.url);
      if (known !== undefined && item.status !== 'deleting' && !ports.has(item.endpointId)) ports.set(item.endpointId, known);
      if (busy.has(item.endpointId)) continue;
      busy.add(item.endpointId);
      // One endpoint's failure must never stop the runner (it supervises the others).
      void handle(item)
        .catch((err) => log('handle failed', { endpointId: item.endpointId, error: (err as Error).message }))
        .finally(() => busy.delete(item.endpointId));
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

async function main(): Promise<void> {
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  if (!process.env.AWS_ENDPOINT_URL_DYNAMODB) throw new Error('Refusing to run without AWS_ENDPOINT_URL_DYNAMODB (DynamoDB Local only).');
  log('started', { runtime: RUNTIME_DIR, poll: POLL_MS });
  // Children must never outlive the runner: an orphan keeps its port and the next runner
  // could not give the endpoint its URL back. 'exit' handlers run synchronously, so SIGKILL.
  process.on('exit', () => {
    for (const { child } of running.values()) child.kill('SIGKILL');
  });
  process.on('uncaughtException', (err) => {
    log('crashed', { error: err.message });
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    log('crashed', { error: (err as Error)?.message ?? String(err) });
    process.exit(1);
  });
  const shutdown = async () => {
    await Promise.all([...running.keys()].map(stop));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  for (;;) {
    await tick().catch((err) => log('tick failed', { error: (err as Error).message }));
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

await main();
