// Local entry: the same runtime as Lambda, as a plain Node HTTP server on PORT.
// Started by the admin's local runner (platform/admin/scripts/local-runner.ts) in
// place of a provisioned Lambda. Env is the Lambda's (config.ts) plus:
//   PORT               listen port
//   SLIME_CRYSTAL_DIR  where Crystallize writes modules; read again on restart
// Adds what only a laptop needs: the live feed, saved handlers for the
// Lifecycle tab, and POST /v0/crystallize. Every route needs x-api-key: the
// endpoint key, or for POST /v0/e/<key> that Crystal's own token (CRYSTAL_TOKENS).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createSlime, type SlimeStore } from '@slime-cloud/core';
import { crystallize, DEFAULT_MIN_RUNS } from '@slime-cloud/core/crystallize';
import { createApp, type SavedHandler } from './app.js';
import { isAuthorized, parseCrystalTokens } from './auth.js';
import { slimeConfigFromEnv } from './config.js';
import { RecentRequests } from './events.js';
import { UsageMeter } from './usage.js';
import { syncLiveRuns } from './live-runs.js';

export { syncLiveRuns };

const HANDLERS_NS = 'handlers';
const MAX_BODY_BYTES = 64 * 1024;

/**
 * A read-only view whose list() returns only `keys`: crystallize() has no key
 * filter. crystallize() only reads (store.list / store.get), so the view refuses
 * writes rather than quietly letting a job mutate the real store through it.
 */
export function storeLimitedTo(store: SlimeStore, keys: readonly string[]): SlimeStore {
  const wanted = new Set(keys);
  const readonly = () => {
    throw new Error('storeLimitedTo is a read-only view');
  };
  return {
    get: (ns, key) => store.get(ns, key),
    put: readonly,
    delete: readonly,
    list: async (ns, prefix) => (await store.list(ns, prefix)).filter(({ key }) => ns !== HANDLERS_NS || wanted.has(key)),
  };
}

type RecordLike = { key: string; intent: string; tier: 'gas' | 'liquid'; runs: number; review: string; fixtures: unknown[]; createdAt: string };

export function toSavedHandler(value: unknown): SavedHandler {
  const r = value as RecordLike;
  return { key: r.key, intent: r.intent, tier: r.tier, runs: r.runs, review: r.review, fixtures: r.fixtures?.length ?? 0, createdAt: r.createdAt };
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT || 8700);
  const crystalDir = process.env.SLIME_CRYSTAL_DIR;
  // Same usage counters as Lambda (USAGE#<tenant> items), so the admin's Usage, Billing and
  // list show real numbers locally too. Set by the runner; absent means no metering.
  let meter: UsageMeter | undefined;
  const config = await slimeConfigFromEnv(process.env, {
    onEvent: (event) => {
      if (event.type === 'generated') meter?.recordTokens(event.tokens);
    },
  });
  const slime = await createSlime(config);
  if (process.env.SLIME_USAGE_TABLE) {
    const crystalCount = Object.keys(config.crystal || {}).length;
    meter = new UsageMeter(process.env.SLIME_USAGE_TABLE, process.env.SLIME_TENANT_ID ?? '', () => ({
      ...slime.stats().handlers,
      crystal: crystalCount,
    }));
  }
  const store = config.store;
  const events = new RecentRequests();
  const crystalTokens = parseCrystalTokens(process.env.CRYSTAL_TOKENS);
  const crystalRuns = Number(process.env.CRYSTAL_MIN_RUNS || DEFAULT_MIN_RUNS);

  const app = createApp({
    slime,
    connector: config.connector,
    crystal: config.crystal,
    events,
    onQuery: (meta) => meter?.record(meta),
    thresholds: { liquidRuns: config.tiers.gasToLiquidRuns, crystalRuns },
    savedHandlers: async () => (store ? (await store.list(HANDLERS_NS)).map(({ value }) => toSavedHandler(value)) : []),
    ...(store && crystalDir
      ? {
          crystallize: async (keys?: string[]) => {
            // Liquid run counts and fixtures must be in the store before the job reads them.
            await slime.flush();
            await syncLiveRuns(store, slime.handlers(), keys);
            return crystallize({
              connector: config.connector,
              store: keys ? storeLimitedTo(store, keys) : store,
              dir: crystalDir,
              minRuns: crystalRuns,
            });
          },
        }
      : {}),
  });

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!isAuthorized(req.method ?? 'GET', path, header(req, 'x-api-key'), process.env.SLIME_API_KEY, crystalTokens)) {
        return send(res, Response.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or wrong x-api-key.', retryable: false } }, { status: 401 }));
      }
      const response = await app.fetch(await toRequest(req, port));
      // Same as Lambda: finish store writes and usage before answering, so the admin reads current numbers.
      await Promise.all([slime.flush(), meter?.flush()]);
      await send(res, response);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) await send(res, Response.json({ error: { code: 'INTERNAL', message: 'Unexpected server error.', retryable: true } }, { status: 500 }));
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const crystals = Object.keys(config.crystal || {}).length;
    console.log(JSON.stringify({ listening: `http://localhost:${port}/`, crystals, mode: config.mode }));
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function toRequest(req: IncomingMessage, port: number): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) break;
    chunks.push(chunk as Buffer);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  return new Request(`http://localhost:${port}${req.url ?? '/'}`, {
    method: req.method,
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
