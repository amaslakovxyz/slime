// Local entry: the same runtime as Lambda, as a plain Node HTTP server on PORT.
// Started by the admin's local runner (platform/admin/scripts/local-runner.ts) in
// place of a provisioned Lambda. Env is the Lambda's (config.ts) plus:
//   PORT               listen port
//   SLIME_CRYSTAL_DIR  where Crystallize writes modules; read again on restart
// Adds what only a laptop needs: the live feed, saved handlers for the
// Lifecycle tab, and POST /v0/crystallize. Every route needs x-api-key.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createSlime, type SlimeStore } from '@slime-cloud/core';
import { crystallize, DEFAULT_MIN_RUNS } from '@slime-cloud/core/crystallize';
import { createApp, type SavedHandler } from './app.js';
import { keyMatches } from './auth.js';
import { slimeConfigFromEnv } from './config.js';
import { RecentRequests } from './events.js';

const HANDLERS_NS = 'handlers';
const MAX_BODY_BYTES = 64 * 1024;

/** A read-only view whose list() returns only `keys`: crystallize() has no key filter. */
export function storeLimitedTo(store: SlimeStore, keys: readonly string[]): SlimeStore {
  const wanted = new Set(keys);
  return {
    get: (ns, key) => store.get(ns, key),
    put: (ns, key, value) => store.put(ns, key, value),
    delete: (ns, key) => store.delete(ns, key),
    list: async (ns, prefix) => (await store.list(ns, prefix)).filter(({ key }) => ns !== HANDLERS_NS || wanted.has(key)),
  };
}

/**
 * The core saves a handler once, when it turns Liquid; later runs only count in
 * memory. Crystallize reads runs from the store, so copy the live counts there
 * first (never lowering a saved count).
 */
export async function syncLiveRuns(store: SlimeStore, live: readonly { key: string; runs: number }[], keys?: readonly string[]): Promise<void> {
  const wanted = keys ? new Set(keys) : undefined;
  for (const { key, runs } of live) {
    if (wanted && !wanted.has(key)) continue;
    const saved = (await store.get(HANDLERS_NS, key)) as { runs?: number } | undefined;
    if (saved && typeof saved.runs === 'number' && runs > saved.runs) await store.put(HANDLERS_NS, key, { ...saved, runs });
  }
}

type RecordLike = { key: string; intent: string; tier: 'gas' | 'liquid'; runs: number; review: string; fixtures: unknown[]; createdAt: string };

export function toSavedHandler(value: unknown): SavedHandler {
  const r = value as RecordLike;
  return { key: r.key, intent: r.intent, tier: r.tier, runs: r.runs, review: r.review, fixtures: r.fixtures?.length ?? 0, createdAt: r.createdAt };
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT || 8700);
  const crystalDir = process.env.SLIME_CRYSTAL_DIR;
  const config = await slimeConfigFromEnv(process.env);
  const slime = await createSlime(config);
  const store = config.store;
  const events = new RecentRequests();
  const crystalRuns = Number(process.env.CRYSTAL_MIN_RUNS || DEFAULT_MIN_RUNS);

  const app = createApp({
    slime,
    connector: config.connector,
    crystal: config.crystal,
    events,
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
      if (!keyMatches(header(req, 'x-api-key'), process.env.SLIME_API_KEY)) {
        return send(res, Response.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or wrong x-api-key.', retryable: false } }, { status: 401 }));
      }
      const response = await app.fetch(await toRequest(req, port));
      // Same as Lambda: finish store writes before answering, so the admin reads current runs.
      await slime.flush();
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
