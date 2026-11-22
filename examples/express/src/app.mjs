// The app's three endpoints: Slime, crystallize, health. A client sends the request
// itself ({ intent, input, output }), so whoever can reach /query can ask anything the
// read-only database user can read (R8): put this behind your own auth outside a demo.
import express from 'express';
import { SlimeError } from '@slime-cloud/core';

const INTERNAL_ERROR = { code: 'INTERNAL', message: 'Unexpected server error.', retryable: true };

/**
 * POST /query        `{ intent, input?, output }` → Slime's answer.
 * POST /crystallize  `{ keys? }` → the crystallize reports: ready handlers become Crystal
 *                    in the crystallizer's folder (this app's slime-crystal/).
 * GET  /health       `slime.stats()`.
 */
export function createApp(slime, crystallizer) {
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.post('/query', async (request, response) => response.json(await slime.query(request.body)));
  app.post('/crystallize', async (request, response) => {
    const keys = request.body?.keys;
    if (keys !== undefined && !(Array.isArray(keys) && keys.every((key) => typeof key === 'string'))) {
      throw new SlimeError('INVALID_REQUEST', '`keys` must be an array of handler keys.');
    }
    response.json({ reports: await crystallizer.run(keys ? { keys } : {}) });
  });
  app.get('/health', (_request, response) => response.json(slime.stats()));

  app.use((error, _request, response, _next) => {
    if (error instanceof SlimeError) return response.status(error.status).json({ error: error.toJSON() });
    // body-parser's own 4xx (malformed JSON, body over the limit): the client must fix it, so not retryable.
    if (error.expose && error.status >= 400 && error.status < 500) {
      return response.status(error.status).json({ error: { code: 'INVALID_REQUEST', message: `The request body is not valid: ${error.message}`, retryable: false } });
    }
    console.error(error);
    return response.status(500).json({ error: INTERNAL_ERROR });
  });
  return app;
}
