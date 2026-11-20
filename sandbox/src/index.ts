import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { config } from './config.js';
import { PostgresConnector } from './connectors/postgres.js';
import { Engine } from './engine.js';

const connector = new PostgresConnector(config.databaseUrl);
const engine = await Engine.create(connector);

const app = createApp(engine, connector);

const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  const s = engine.stats();
  console.log(
    `Slime sandbox on http://127.0.0.1:${info.port}  mode=${s.mode}  model=${s.model}  ` +
      `store=${s.store.kind} (loaded ${s.store.loadedOnStart} Liquid)  tables=${s.tables.join(',')}`,
  );
});

// Finish pending store writes so a handler promoted just before shutdown is not lost.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    server.close();
    await engine.close();
    await connector.close();
    process.exit(0);
  });
}
