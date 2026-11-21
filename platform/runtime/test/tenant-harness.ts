// The Lambda router and tenant cache wired to fakes (SSM, S3, DynamoDB) and the demo
// Postgres (examples/express/db/init.sql: its docker compose, or CI's service), with
// the offline provider, so a test drives endpoints end to end with no AWS and no model.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { QuickJSRunner, type StoreEntry } from '@slime-cloud/core';
import { S3CrystalStore } from '../src/crystal-store.js';
import { endpointRuntime, type EndpointRuntime } from '../src/endpoint-runtime.js';
import { createRouter } from '../src/lambda.js';
import { DynamoSlimeStore } from '../src/store-dynamodb.js';
import { ENDPOINTS_SSM_PREFIX, TenantCache } from '../src/tenants.js';
import { FakeDynamo } from './fake-dynamo.js';
import { FakeS3 } from './fake-s3.js';
import { FakeSsm } from './fake-ssm.js';

export const DEMO_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://slime_reader:slime_reader@localhost:54329/slime';
export const BUCKET = 'slime-crystals-test';
const HANDLERS_TABLE = 'slime-handlers';
const CONNECT_TIMEOUT_MS = 2_000;

/** Locally, database tests are skipped when Postgres is down; CI sets REQUIRE_DB=1 so they fail instead. */
export async function isDatabaseAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DEMO_DATABASE_URL, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch (error) {
    const reason = (error as Error).message;
    if (process.env.REQUIRE_DB === '1') throw new Error(`REQUIRE_DB=1 but Postgres is unreachable: ${reason}`);
    console.warn(`# skipping database tests: ${reason} (start it with: cd examples/express && npm run db:up)`);
    return false;
  }
}

export interface HarnessOptions {
  maxEntries?: number;
  ttlMs?: number;
}

export interface CallOptions {
  key?: string;
  method?: string;
  body?: unknown;
}

/** The parts of a reply the tests read. */
export interface Reply {
  status: number;
  json?: {
    error?: { code: string; message: string };
    data?: unknown;
    meta?: { tier: string; cache: string; handlerKey: string };
    reports?: { key: string; outcome: string; reasons: string[] }[];
    handlers?: { key: string; tier: string; runs: number }[];
    instance?: boolean;
  };
}

export interface Harness {
  ssm: FakeSsm;
  s3: FakeS3;
  tenants: TenantCache;
  /** The cache's clock: move `now` forward to pass the TTL. */
  clock: { now: number };
  /** Every runtime built, in order. */
  built: { id: string; runtime: EndpointRuntime }[];
  /** The endpoint ids whose runtime was closed, in order. */
  closed: string[];
  /** Writes the endpoint's settings as the admin does: offline provider, the demo database. */
  addEndpoint(id: string, values?: Record<string, string>): void;
  /** The endpoint's current engine on this instance. */
  runtimeOf(id: string): Promise<EndpointRuntime>;
  call(path: string, options?: CallOptions): Promise<Reply>;
  savedHandlers(id: string): Promise<StoreEntry[]>;
  close(): Promise<void>;
}

/** One Lambda instance's router over fakes; call close() in `after`. */
export async function harness({ maxEntries = 8, ttlMs = 30_000 }: HarnessOptions = {}): Promise<Harness> {
  const ssm = new FakeSsm();
  const s3 = new FakeS3();
  const dynamo = new FakeDynamo();
  const runner = new QuickJSRunner();
  const workRoot = await mkdtemp(join(tmpdir(), 'slime-tenants-test-'));
  const clock = { now: 1_000_000 };
  const built: { id: string; runtime: EndpointRuntime }[] = [];
  const closed: string[] = [];

  const tenants = new TenantCache({
    ssm,
    crystals: new S3CrystalStore({ bucket: BUCKET, client: s3, workRoot }),
    baseEnv: { SLIME_HANDLERS_TABLE: HANDLERS_TABLE },
    sharedPrefix: '/slime/shared/',
    maxEntries,
    ttlMs,
    runner,
    now: () => clock.now,
    log: () => {},
    build: async (env, deps) => {
      const id = env.SLIME_TENANT_ID ?? '';
      const runtime = await endpointRuntime(env, { ...deps, storeClient: dynamo, log: () => {} });
      const close = runtime.close;
      runtime.close = async () => {
        closed.push(id);
        await close();
      };
      built.push({ id, runtime });
      return runtime;
    },
  });
  const router = createRouter(tenants, { flushLimitMs: 5_000, log: () => {} });

  return {
    ssm,
    s3,
    tenants,
    clock,
    built,
    closed,
    addEndpoint(id: string, values: Record<string, string> = {}): void {
      ssm.putAll(`${ENDPOINTS_SSM_PREFIX}${id}/`, { DATABASE_URL: DEMO_DATABASE_URL, SLIME_API_KEY: keyOf(id), SLIME_PROVIDER: 'offline', ...values });
    },
    async runtimeOf(id: string): Promise<EndpointRuntime> {
      const tenant = await tenants.get(id);
      if (!tenant) throw new Error(`${id} is not an endpoint`);
      return tenant.runtime();
    },
    async call(path: string, { key, method, body }: CallOptions = {}): Promise<Reply> {
      const response = await router.request(path, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { ...(key ? { 'x-api-key': key } : {}), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, ...(text ? { json: JSON.parse(text) as Reply['json'] } : {}) };
    },
    savedHandlers(id: string) {
      return new DynamoSlimeStore({ table: HANDLERS_TABLE, tenantId: id, client: dynamo }).list('handlers');
    },
    async close(): Promise<void> {
      for (const id of new Set(built.map((b) => b.id))) await tenants.reload(id);
      await runner.close();
      await rm(workRoot, { recursive: true, force: true });
    },
  };
}

/** The endpoint key a test endpoint gets from addEndpoint. */
export function keyOf(id: string): string {
  return `slm_${id}`;
}
