import { serve } from '@hono/node-server';
import { createSlime } from '@slime-cloud/core';
import { Crystallizer } from '@slime-cloud/crystal';
import { createApp } from './app.mjs';
import { CRYSTAL_DIR, slimeConfigFromEnv } from './config.mjs';

const DEFAULT_PORT = 3000;
const slime = await createSlime(await slimeConfigFromEnv(process.env, { onEvent: logEvent }));
const crystallizer = new Crystallizer(slime, { dir: CRYSTAL_DIR });
const port = Number(process.env.PORT || DEFAULT_PORT);
const server = serve({ fetch: createApp(slime, crystallizer).fetch, port }, () =>
  console.log(`Slime multi-source example on http://localhost:${port} (POST /slime, POST /crystallize, GET /health)`),
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close();
    void slime.close();
  });
}

function logEvent(event) {
  if (event.type === 'generated') console.log(`[slime] generated ${event.handlerKey.slice(0, 12)}: ${(event.steps ?? []).map((step) => step.operation ?? 'sql').join(' + ')}`);
  else if (event.type === 'reviewed') console.log(`[slime] review ${event.verdict}: ${event.notes || 'no problems'}`);
  else console.log(`[slime] ${event.type}: ${event.message ?? event.handlerKey}`);
}
