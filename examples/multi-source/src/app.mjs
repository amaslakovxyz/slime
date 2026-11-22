// Three endpoints, as in examples/express and examples/hono. POST /slime passes the
// frontend's { intent, input, output } to Slime: development only (S7, R8).
// POST /crystallize turns ready handlers into Crystal, the ones that read Notion or the
// films API included: their steps run through the app's sources.
import { SlimeError } from '@slime-cloud/core';
import { Hono } from 'hono';

export function createApp(slime, crystallizer) {
  return new Hono()
    .post('/slime', async (c) => c.json(await slime.query(await jsonBody(c))))
    .post('/crystallize', async (c) => c.json({ reports: await crystallizer.run({ keys: (await jsonBody(c, {})).keys }) }))
    .get('/health', (c) => c.json(slime.stats()))
    .onError((error, c) => c.json({ error: error.toJSON?.() ?? { code: 'INTERNAL' } }, error.status ?? 500));
}

/** A body that is not JSON is the client's mistake (400), not a server error (500); `empty` stands in for no body. */
async function jsonBody(c, empty) {
  const text = await c.req.text();
  if (text === '' && empty !== undefined) return empty;
  try {
    return JSON.parse(text);
  } catch {
    throw new SlimeError('INVALID_REQUEST', 'Body must be valid JSON.');
  }
}
