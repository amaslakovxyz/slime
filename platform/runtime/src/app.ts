// HTTP routes of the hosted runtime, on @slime-cloud/core's Slime API (PLAN.md §5).
// Same routes as before M7, so clients don't change; once @slime-cloud/server
// exists this file becomes an import of its route factory.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { SlimeError, type Connector, type CrystalRegistry, type QueryMeta, type Slime } from '@slime-cloud/core';
import type { RecentRequests } from './events.js';

/** A handler as the admin's Lifecycle tab sees it. */
export interface LifecycleHandler {
  key: string;
  intent: string;
  tier: 'gas' | 'liquid' | 'crystal';
  runs: number;
  review?: string;
  fixtures?: number;
  createdAt?: string;
}

/** A saved handler record, reduced to what the Lifecycle tab needs. */
export type SavedHandler = Omit<LifecycleHandler, 'tier'> & { tier: 'gas' | 'liquid' };

export interface CrystallizeOutcome {
  key: string;
  intent: string;
  outcome: string;
  reasons: string[];
}

export interface RuntimeParts {
  slime: Slime;
  connector: Connector;
  crystal: CrystalRegistry | false;
  /** Sees every answered query (the Lambda entry meters usage with it). */
  onQuery?: (meta: QueryMeta) => void;
  /** Local runtime only: the live feed behind `GET /v0/events`. */
  events?: RecentRequests;
  /** Local runtime only: saved handlers, so Liquid ones show before their first hit after a restart. */
  savedHandlers?: () => Promise<SavedHandler[]>;
  /** Local runtime only: `POST /v0/crystallize`. Absent means the route does not exist. */
  crystallize?: (keys?: string[]) => Promise<CrystallizeOutcome[]>;
  /** Runs needed for Gas → Liquid and for Crystal readiness, shown as progress. */
  thresholds?: { liquidRuns: number; crystalRuns: number };
}

const TIER_RANK = { gas: 0, liquid: 1, crystal: 2 } as const;

/** One row per handler key; the most mature tier wins and runs never go backwards. */
export function mergeHandlers(lists: LifecycleHandler[][]): LifecycleHandler[] {
  const byKey = new Map<string, LifecycleHandler>();
  for (const handler of lists.flat()) {
    const seen = byKey.get(handler.key);
    if (!seen) {
      byKey.set(handler.key, { ...handler });
      continue;
    }
    const winner = TIER_RANK[handler.tier] > TIER_RANK[seen.tier] ? { ...seen, ...handler } : { ...handler, ...seen };
    winner.runs = Math.max(seen.runs, handler.runs);
    byKey.set(handler.key, winner);
  }
  return [...byKey.values()].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

const MAX_BODY_BYTES = 16 * 1024;

export function createApp({ slime, connector, crystal, onQuery, events, savedHandlers, crystallize, thresholds }: RuntimeParts): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof SlimeError) return c.json({ error: error.toJSON() }, error.status as 400);
    console.error(error);
    return c.json({ error: { code: 'INTERNAL', message: 'Unexpected server error.', retryable: true } }, 500);
  });

  // The one data endpoint. Behind the API key: callers are the tenant's own backend, not browsers.
  app.post(
    '/v0/query',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: { code: 'INVALID_REQUEST', message: 'Body larger than 16 KB.', retryable: false } }, 413),
    }),
    async (c) => {
      const body = await c.req.json().catch(() => {
        throw new SlimeError('INVALID_REQUEST', 'Body must be valid JSON.');
      });
      const { data, meta } = await slime.query(body);
      onQuery?.(meta);
      events?.record(meta);
      c.header('Server-Timing', `total;dur=${meta.timingsMs.total}, generate;dur=${meta.timingsMs.generate ?? 0}`);
      console.log(JSON.stringify({ at: new Date().toISOString(), handler: meta.handlerKey, tier: meta.tier, cache: meta.cache, ms: meta.timingsMs }));
      return c.json({ data, meta });
    },
  );

  // Admin views (behind the API key in the Lambda entry).
  app.get('/healthz', async (c) => {
    const safety = await connector.safetyCheck();
    return c.json({ ok: safety.ok, database: safety, ...slime.stats() }, safety.ok ? 200 : 503);
  });
  app.get('/v0/handlers', (c) => {
    const crystals = Object.entries(crystal || {}).map(([key, { intent }]) => ({ key, intent, tier: 'crystal' }));
    return c.json({ handlers: slime.handlers(), crystals });
  });
  app.delete('/v0/handlers/:key', async (c) =>
    (await slime.evict(c.req.param('key'))) ? c.json({ evicted: true }) : c.json({ evicted: false }, 404),
  );

  // A Crystal is its own endpoint: intent and output are fixed, the body carries only `input`.
  app.post('/v0/e/:key', async (c) => {
    const handler = (crystal || {})[c.req.param('key')];
    if (!handler) throw new SlimeError('HANDLER_NOT_FOUND', 'No Crystal with this key on this endpoint.');
    const body = (await c.req.json().catch(() => ({}))) as { input?: unknown };
    const { data, meta } = await slime.query({ intent: handler.intent, input: body.input ?? {}, output: handler.output } as never);
    onQuery?.(meta);
    events?.record(meta, 'crystal');
    return c.json({ data, meta });
  });

  if (events) app.get('/v0/events', (c) => c.json(events.list()));

  if (savedHandlers) {
    app.get('/v0/lifecycle', async (c) => {
      const live: LifecycleHandler[] = slime.handlers().map((h) => ({ ...h }));
      const crystals: LifecycleHandler[] = Object.entries(crystal || {}).map(([key, h]) => ({
        key,
        intent: h.intent,
        tier: 'crystal',
        runs: 0,
        review: h.review,
      }));
      return c.json({ handlers: mergeHandlers([await savedHandlers(), live, crystals]), stats: slime.stats(), thresholds });
    });
  }

  if (crystallize) {
    app.post('/v0/crystallize', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { keys?: unknown };
      const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === 'string') : undefined;
      return c.json({ reports: await crystallize(keys) });
    });
  }

  return app;
}
