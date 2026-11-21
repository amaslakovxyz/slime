// Lambda entry for the Slime runtime (Function URL; see platform/infra/platform/runtime.tf).
//
// Cold start:
//   1. Every SSM parameter under SLIME_SSM_PREFIX becomes an env var named after
//      its last path segment (/slime/runtime/DATABASE_URL -> DATABASE_URL).
//      Secrets therefore never pass through Terraform state or the function config.
//   2. The Slime instance is built from those env vars (config.ts) on the first
//      request, and rebuilt on the next one if that fails (e.g. DATABASE_URL not
//      set yet), so a broken DB is a 503, not a crash loop.
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

if (process.env.SLIME_SSM_PREFIX) await loadParameters(process.env.SLIME_SSM_PREFIX);

type Runtime = { app: Hono; flush: () => Promise<void> };

// flush() also waits for background reviews, which can outlast the 30 s function
// timeout. Past this cap the response goes out; an unfinished review continues
// when the instance is next woken, or is retried after a later run.
const FLUSH_LIMIT_MS = Number(process.env.SLIME_FLUSH_LIMIT_MS || 5_000);
let booting: Promise<Runtime> | null = null;

function boot(): Promise<Runtime> {
  booting ??= (async () => {
    const { createSlime } = await import('@slime-cloud/core');
    const { slimeConfigFromEnv } = await import('./config.js');
    const { createApp } = await import('./app.js');
    const config = await slimeConfigFromEnv();
    const slime = await createSlime(config);
    return { app: createApp({ slime, connector: config.connector, crystal: config.crystal }), flush: () => slime.flush() };
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
  // Lambda freezes the process after the response; finish store writes and reviews first (C15).
  await Promise.race([runtime.flush(), new Promise((resolve) => setTimeout(resolve, FLUSH_LIMIT_MS).unref())]);
  return res;
});

export const handler = handle(app);
