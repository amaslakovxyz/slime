// HTTP routes of the hosted runtime, on @slime-cloud/core's Slime API (PLAN.md §5).
// Same routes as before M7, so clients don't change; once @slime-cloud/server
// exists this file becomes an import of its route factory.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { SlimeError, type Connector, type CrystalRegistry, type Slime } from '@slime-cloud/core';

export interface RuntimeParts {
  slime: Slime;
  connector: Connector;
  crystal: CrystalRegistry | false;
}

const MAX_BODY_BYTES = 16 * 1024;

export function createApp({ slime, connector, crystal }: RuntimeParts): Hono {
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

  return app;
}
