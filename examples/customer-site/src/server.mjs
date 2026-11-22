import { serve } from '@hono/node-server';
import { createApp } from './app.mjs';

const DEFAULT_PORT = 4000;
const port = Number(process.env.PORT || DEFAULT_PORT);
const server = serve({ fetch: createApp().fetch, port }, () => console.log(`Atlas customer site on http://localhost:${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
