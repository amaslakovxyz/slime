// Two endpoints, as in examples/hono. POST /slime passes the frontend's
// { intent, input, output } to Slime: development only (S7, R8).
import { Hono } from 'hono';

export function createApp(slime) {
  return new Hono()
    .get('/health', (c) => c.json(slime.stats()))
    .post('/slime', async (c) => c.json(await slime.query(await c.req.json())))
    .onError((error, c) => c.json({ error: error.toJSON?.() ?? { code: 'INTERNAL' } }, error.status ?? 500));
}
