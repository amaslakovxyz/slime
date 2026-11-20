// HTTP routes of the hosted runtime. They mirror sandbox/src/index.ts; once
// @slime-cloud/server exists this file becomes an import of its route factory.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Connector } from '@slime-cloud/core/connectors/types.js';
import type { Engine, QueryMeta } from '@slime-cloud/core/engine.js';
import { SlimeError } from '@slime-cloud/core/errors.js';

/** `onQuery` sees every answered query (the Lambda entry meters usage with it). */
export function createApp(engine: Engine, connector: Connector, onQuery?: (meta: QueryMeta) => void): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof SlimeError) {
      return c.json({ error: err.toJSON() }, err.status as 400);
    }
    console.error(err);
    return c.json({ error: { code: 'INTERNAL', message: 'Unexpected server error.', retryable: true } }, 500);
  });

  // The one data endpoint.
  app.post(
    '/v0/query',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => c.json({ error: { code: 'INVALID_REQUEST', message: 'Body larger than 16 KB.', retryable: false } }, 413),
    }),
    async (c) => {
      const body = await c.req.json().catch(() => {
        throw new SlimeError('INVALID_REQUEST', 'Body must be valid JSON.');
      });
      const { data, meta } = await engine.query(body);
      onQuery?.(meta);
      c.header('Server-Timing', `total;dur=${meta.timingsMs.total}, generate;dur=${meta.timingsMs.generate}`);
      console.log(
        JSON.stringify({ at: new Date().toISOString(), handler: meta.handlerId, tier: meta.tier, cache: meta.cache, ms: meta.timingsMs }),
      );
      return c.json({ data, meta });
    },
  );

  // Admin views. The local server listens on localhost only and has no auth;
  // the Lambda entry puts every route behind an API key.
  app.get('/healthz', async (c) => {
    const safety = await connector.safetyCheck();
    return c.json({ ok: safety.ok, database: safety, ...engine.stats() }, safety.ok ? 200 : 503);
  });
  app.get('/v0/handlers', (c) => c.json({ handlers: engine.listHandlers(), crystals: engine.listCrystals() }));
  app.delete('/v0/handlers/:id', (c) =>
    engine.evict(c.req.param('id')) ? c.json({ evicted: true }) : c.json({ evicted: false }, 404),
  );

  return app;
}
