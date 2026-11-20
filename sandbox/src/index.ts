import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { config } from './config.js';
import { PostgresConnector } from './connectors/postgres.js';
import { Engine } from './engine.js';
import { SlimeError } from './errors.js';

const connector = new PostgresConnector(config.databaseUrl);
const engine = await Engine.create(connector);

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
    c.header('Server-Timing', `total;dur=${meta.timingsMs.total}, generate;dur=${meta.timingsMs.generate}`);
    console.log(
      JSON.stringify({ at: new Date().toISOString(), handler: meta.handlerId, tier: meta.tier, cache: meta.cache, ms: meta.timingsMs }),
    );
    return c.json({ data, meta });
  },
);

// Admin views. This sandbox listens on localhost only and has no auth:
// a deployed version must put these behind an admin key.
app.get('/healthz', async (c) => {
  const safety = await connector.safetyCheck();
  return c.json({ ok: safety.ok, database: safety, ...engine.stats() }, safety.ok ? 200 : 503);
});
app.get('/v0/handlers', (c) => c.json({ handlers: engine.listHandlers() }));
app.delete('/v0/handlers/:id', (c) =>
  engine.evict(c.req.param('id')) ? c.json({ evicted: true }) : c.json({ evicted: false }, 404),
);

serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  const s = engine.stats();
  console.log(`Slime sandbox on http://127.0.0.1:${info.port}  mode=${s.mode}  model=${s.model}  tables=${s.tables.join(',')}`);
});
