// Lambda entry for the Slime runtime (Function URL; see infra/aws/platform/runtime.tf).
//
// Cold start:
//   1. Every SSM parameter under each path in SLIME_SSM_PREFIX (comma-separated)
//      becomes an env var named after its last path segment
//      (/slime/runtime/DATABASE_URL -> DATABASE_URL). Paths load in order, so a
//      later one overrides an earlier one: provisioned endpoints use
//      "/slime/shared/,/slime/endpoints/<id>/" (shared model keys, then their own).
//      Secrets therefore never pass through Terraform state or the function config.
//   2. Only then are config.ts and the engine imported: config reads env at import.
//   3. The engine starts on the first request and is retried on the next one if
//      it fails (e.g. DATABASE_URL not set yet), so a broken DB is a 503, not a
//      crash loop.
// Every route needs the `x-api-key` header to equal SLIME_API_KEY; with no key
// configured the runtime refuses everything.
import { createHash, timingSafeEqual } from 'node:crypto';
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';

export function keyMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  // Hash both sides so timingSafeEqual gets equal lengths.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Parameter path -> env var name: the last path segment. */
export function envNameFor(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

async function loadParameters(prefix: string): Promise<void> {
  const ssm = new SSMClient({});
  let NextToken: string | undefined;
  do {
    const res = await ssm.send(new GetParametersByPathCommand({ Path: prefix, WithDecryption: true, NextToken }));
    for (const p of res.Parameters ?? []) {
      if (p.Name && p.Value !== undefined) process.env[envNameFor(p.Name)] = p.Value;
    }
    NextToken = res.NextToken;
  } while (NextToken);
}

for (const prefix of (process.env.SLIME_SSM_PREFIX ?? '').split(',')) {
  if (prefix.trim()) await loadParameters(prefix.trim());
}

type Runtime = { app: Hono; flush: () => Promise<void> };
let booting: Promise<Runtime> | null = null;

function boot(): Promise<Runtime> {
  booting ??= (async () => {
    const { config } = await import('@slime-cloud/core/config.js');
    const { PostgresConnector } = await import('@slime-cloud/core/connectors/postgres.js');
    const { Engine } = await import('@slime-cloud/core/engine.js');
    const { DynamoHandlerStore } = await import('./store-dynamodb.js');
    const { UsageMeter } = await import('./usage.js');
    const { createApp } = await import('./app.js');
    const connector = new PostgresConnector(config.databaseUrl);
    const store = new DynamoHandlerStore(process.env.SLIME_HANDLERS_TABLE ?? '', process.env.SLIME_TENANT_ID ?? '');
    const engine = await Engine.create(connector, { store });
    // Only provisioned endpoints meter usage (slime-runtime has no usage table).
    const meter = process.env.SLIME_USAGE_TABLE
      ? new UsageMeter(process.env.SLIME_USAGE_TABLE, process.env.SLIME_TENANT_ID ?? '')
      : undefined;
    return {
      app: createApp(engine, connector, (m) => meter?.record(m)),
      flush: () => Promise.all([engine.flush(), meter?.flush()]).then(() => {}),
    };
  })().catch((err) => {
    booting = null;
    throw err;
  });
  return booting;
}

export const app = new Hono();

app.use('*', async (c, next) => {
  if (!keyMatches(c.req.header('x-api-key'), process.env.SLIME_API_KEY)) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or wrong x-api-key.', retryable: false } }, 401);
  }
  await next();
});

app.all('*', async (c) => {
  let runtime: Runtime;
  try {
    runtime = await boot();
  } catch (err) {
    console.error(err);
    return c.json({ error: { code: 'NOT_READY', message: `Runtime is not ready: ${(err as Error).message}`, retryable: true } }, 503);
  }
  const res = await runtime.app.fetch(c.req.raw);
  // Lambda freezes the process after the response; persist store writes first.
  await runtime.flush();
  return res;
});

export const handler = handle(app);
