// Two endpoints, as in examples/hono. POST /slime passes the frontend's
// { intent, input, output } to Slime: development only (S7, R8).
import { SlimeError } from '@slime-cloud/core';
import { Hono } from 'hono';

export function createApp(slime) {
  return new Hono()
    .get('/health', (c) => c.json(slime.stats()))
    .post('/slime', async (c) => {
      // A body that is not JSON is the client's mistake (400), not a server error (500).
      const body = await c.req.json().catch(() => {
        throw new SlimeError('INVALID_REQUEST', 'Body must be valid JSON.');
      });
      return c.json(await slime.query(body));
    })
    .onError((error, c) => c.json({ error: error.toJSON?.() ?? { code: 'INTERNAL' } }, error.status ?? 500));
}
