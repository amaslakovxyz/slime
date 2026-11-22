// HTTP routes of one endpoint, on @slime-cloud/core's Slime API (PLAN.md §5).
// Same routes as before M7, so clients don't change; once @slime-cloud/server
// exists this file becomes an import of its route factory. Both entries mount
// every part (endpoint-runtime.ts); the Lambda router serves these under /ep/<id>/.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { SlimeError, type Connector, type CrystalRegistry, type LayerSpan, type QueryMeta, type Slime } from '@slime-cloud/core';
import { MAX_PAGE_LIMIT, type PageQuery, type RequestFailure, type RequestFeed } from './events.js';
import type { HandlerCode } from './handler-code.js';

/** A handler as the admin's Lifecycle tab sees it. */
export interface LifecycleHandler {
  key: string;
  intent: string;
  tier: 'gas' | 'liquid' | 'crystal';
  runs: number;
  review?: string;
  fixtures?: number;
  createdAt?: string;
  /** Crystal only: the input names (and types, when known) its own route takes. */
  inputs?: Record<string, string | null>;
  /** Saved with another schema, dictionary, prompt or model: regenerates on next request; cannot be crystallized. */
  stale?: boolean;
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
  /** Absent behaves as `false`: no Crystal routes. */
  crystal?: CrystalRegistry | false;
  /** Sees every answered query (usage metering). */
  onQuery?: (meta: QueryMeta) => void;
  /** One JSON line per answered query; defaults to stdout. */
  log?: (line: Record<string, unknown>) => void;
  /** The live feed behind `GET /v0/events`. Absent means the route does not exist. */
  events?: RequestFeed;
  /** Saved handlers, so Liquid ones show before their first hit after a restart. Mounts `GET /v0/lifecycle`. */
  savedHandlers?: () => Promise<SavedHandler[]>;
  /** `POST /v0/crystallize`. Absent means the route does not exist. */
  crystallize?: (keys?: string[]) => Promise<CrystallizeOutcome[]>;
  /** `GET /v0/handlers/:key/code`, for the Requests log's trace drawer. Absent means the route does not exist. */
  handlerCode?: (key: string) => Promise<HandlerCode | undefined>;
  /** Runs needed for Gas → Liquid and for Crystal readiness, shown as progress. */
  thresholds?: { liquidRuns: number; crystalRuns: number };
  /** Startup and engine warnings, shown in the Lifecycle tab. */
  warnings?: () => string[];
  /**
   * Gas rows are this process's only, one of several (the shared Lambda): `/v0/lifecycle`
   * says `instance: true`. The feed is shared through the store (StoredRequests).
   */
  isPerInstance?: boolean;
}

const TIER_RANK = { gas: 0, liquid: 1, crystal: 2 } as const;

/** An event id: an ISO time, a counter and a suffix. Anything else is refused before it reaches the store. */
const CURSOR = /^[0-9A-Za-z:.-]{1,64}$/;

/** `?limit=&before=&after=` of GET /v0/events, or the reason it is refused. */
export function pageQuery({ limit, before, after }: Record<string, string | undefined>): PageQuery | string {
  if (before !== undefined && after !== undefined) return 'Pass before or after, not both.';
  for (const cursor of [before, after]) if (cursor !== undefined && !CURSOR.test(cursor)) return 'before and after take an event id from this feed.';
  if (limit !== undefined && !(/^\d+$/.test(limit) && Number(limit) >= 1 && Number(limit) <= MAX_PAGE_LIMIT)) return `limit is a whole number from 1 to ${MAX_PAGE_LIMIT}.`;
  return { ...(limit ? { limit: Number(limit) } : {}), ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

/** A stale saved row ranks below live Gas, so the live row with the same key replaces it. */
function rank(handler: LifecycleHandler): number {
  return handler.stale ? -1 : TIER_RANK[handler.tier];
}

/**
 * One row per handler key; the most mature tier wins and runs never go backwards,
 * except that a live Gas or Liquid row replacing a stale one keeps its own runs:
 * it is regenerated code. A Crystal is never regenerated, so it keeps the history.
 */
export function mergeHandlers(lists: LifecycleHandler[][]): LifecycleHandler[] {
  const byKey = new Map<string, LifecycleHandler>();
  for (const handler of lists.flat()) {
    const seen = byKey.get(handler.key);
    if (!seen) {
      byKey.set(handler.key, { ...handler });
      continue;
    }
    const isNewer = rank(handler) > rank(seen);
    const [winner, loser] = isNewer ? [handler, seen] : [seen, handler];
    // Regenerated code shares nothing with the stale record: not its runs, fixtures or review.
    const isRegenerated = Boolean(loser.stale) && !winner.stale && winner.tier !== 'crystal';
    const merged: LifecycleHandler = isRegenerated ? { ...winner } : { ...loser, ...winner };
    if (!winner.stale) delete merged.stale;
    if (!isRegenerated) merged.runs = Math.max(seen.runs, handler.runs);
    byKey.set(handler.key, merged);
  }
  return [...byKey.values()].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

const MAX_BODY_BYTES = 16 * 1024;

function edgeSpan(contentLength: string | undefined, credential: 'API key' | 'Crystal token'): LayerSpan {
  return { layer: 'edge', status: 'pass', note: contentLength ? `${credential} · body ${contentLength} B` : credential };
}

const FALLBACK_STOP: Record<string, LayerSpan['layer']> = { INVALID_REQUEST: 'key', HANDLER_NOT_FOUND: 'route' };

function failureOf(error: unknown, ms: number, edge: LayerSpan): RequestFailure {
  if (!(error instanceof SlimeError)) return { status: 500, code: 'INTERNAL', ms, trace: [edge] };
  const trace = error.trace ?? [{ layer: FALLBACK_STOP[error.code] ?? 'execute', status: 'stop' as const, note: `${error.code}: ${error.message}`.slice(0, 200) }];
  return { status: error.status, code: error.code, ms, trace: [edge, ...trace], ...(error.handlerKey ? { handlerKey: error.handlerKey } : {}) };
}

export function createApp({ slime, connector, crystal, onQuery, log, events, savedHandlers, crystallize, handlerCode, thresholds, warnings, isPerInstance }: RuntimeParts): Hono {
  const app = new Hono();
  const logLine = log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));

  const limitBody = (credential: 'API key' | 'Crystal token', route?: 'crystal') =>
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => {
        const message = 'Body larger than 16 KB.';
        const edge: LayerSpan = { layer: 'edge', status: 'stop', note: `INVALID_REQUEST: ${message}` };
        events?.recordFailure({ status: 413, code: 'INVALID_REQUEST', ms: 0, trace: [edge] }, route);
        return c.json({ error: { code: 'INVALID_REQUEST', message, retryable: false } }, 413);
      },
    });

  app.onError((error, c) => {
    if (error instanceof SlimeError) return c.json({ error: error.toJSON() }, error.status as 400);
    console.error(error);
    return c.json({ error: { code: 'INTERNAL', message: 'Unexpected server error.', retryable: true } }, 500);
  });

  // The one data endpoint. Behind the API key: callers are the tenant's own backend, not browsers.
  app.post(
    '/v0/query',
    limitBody('API key'),
    async (c) => {
      const startedAt = performance.now();
      const edge = edgeSpan(c.req.header('content-length'), 'API key');
      let body: unknown;
      try {
        body = await c.req.json().catch(() => {
          throw new SlimeError('INVALID_REQUEST', 'Body must be valid JSON.');
        });
        const { data, meta } = await slime.query(body as never);
        onQuery?.(meta);
        events?.record(meta, undefined, { body, edge });
        c.header('Server-Timing', `total;dur=${meta.timingsMs.total}, generate;dur=${meta.timingsMs.generate ?? 0}`);
        logLine({ at: new Date().toISOString(), handler: meta.handlerKey, tier: meta.tier, cache: meta.cache, ms: meta.timingsMs });
        return c.json({ data, meta });
      } catch (error) {
        events?.recordFailure(failureOf(error, performance.now() - startedAt, edge), undefined, { body, edge });
        throw error;
      }
    },
  );

  // Admin views, behind the endpoint key in both entries.
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
  if (handlerCode) {
    app.get('/v0/handlers/:key/code', async (c) => {
      const code = await handlerCode(c.req.param('key'));
      if (!code) throw new SlimeError('HANDLER_NOT_FOUND', 'No handler with this key on this instance or in the store.');
      return c.json(code);
    });
  }

  // A Crystal is its own endpoint: intent and output are fixed, the body carries only `input`.
  // The handler key hashes the input names, so the exact name set is required: a missing or
  // unknown name is refused, and the call can never miss the Crystal and generate.
  app.post('/v0/e/:key', limitBody('Crystal token', 'crystal'), async (c) => {
    const edge = edgeSpan(c.req.header('content-length'), 'Crystal token');
    const startedAt = performance.now();
    let requestBody: unknown;
    try {
      const key = c.req.param('key');
      // Own keys only: `constructor` or `__proto__` must not resolve to Object.prototype members.
      const handler = crystal && Object.hasOwn(crystal, key) ? crystal[key] : undefined;
      if (!handler) throw new SlimeError('HANDLER_NOT_FOUND', 'No Crystal with this key on this endpoint.');
      const body = (await c.req.json().catch(() => ({}))) as { input?: Record<string, unknown> };
      const input = body.input && typeof body.input === 'object' ? body.input : {};
      requestBody = { intent: handler.intent, input };
      const wanted = Object.entries(handler.paramTypes).map(([name, type]) => `${name}${type ? ` (${type})` : ''}`);
      const takes = wanted.length ? `This endpoint takes input: ${wanted.join(', ')}.` : 'This endpoint takes no input.';
      // null means "not given", but the name must still be sent. Own properties only: an
      // inherited name such as `toString` would otherwise pass and change the key.
      const missing = Object.keys(handler.paramTypes).filter((name) => !Object.hasOwn(input, name));
      if (missing.length) {
        throw new SlimeError('INVALID_REQUEST', `${takes} Missing: ${missing.join(', ')}.`);
      }
      const unknown = Object.keys(input).filter((name) => !Object.hasOwn(handler.paramTypes, name));
      if (unknown.length) {
        throw new SlimeError('INVALID_REQUEST', `${takes} Unknown: ${unknown.join(', ')}.`);
      }
      const { data, meta } = await slime.query({ intent: handler.intent, input, output: handler.output } as never);
      onQuery?.(meta);
      events?.record(meta, 'crystal', { body: requestBody, edge });
      return c.json({ data, meta });
    } catch (error) {
      events?.recordFailure(failureOf(error, performance.now() - startedAt, edge), 'crystal', { body: requestBody, edge });
      throw error;
    }
  });

  if (events) {
    app.get('/v0/events', async (c) => {
      const query = pageQuery(c.req.query());
      if (typeof query === 'string') return c.json({ error: { code: 'INVALID_REQUEST', message: query, retryable: false } }, 400);
      return c.json(await events.list(query));
    });
  }

  if (savedHandlers) {
    app.get('/v0/lifecycle', async (c) => {
      const live: LifecycleHandler[] = slime.handlers().map((h) => ({ ...h }));
      const crystals: LifecycleHandler[] = Object.entries(crystal || {}).map(([key, h]) => ({
        key,
        intent: h.intent,
        tier: 'crystal',
        runs: 0,
        review: h.review,
        inputs: { ...h.paramTypes },
      }));
      return c.json({
        handlers: mergeHandlers([await savedHandlers(), live, crystals]),
        stats: slime.stats(),
        thresholds,
        warnings: warnings?.() ?? [],
        ...(isPerInstance ? { instance: true } : {}),
      });
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
