import { createSlime } from '@slime-cloud/core';
import { createApp } from './app.mjs';
import { Crystallizer } from '@slime-cloud/crystal';
import { CRYSTAL_DIR, optimizerFromEnv, slimeConfigFromEnv } from './config.mjs';

const DEFAULT_PORT = 3000;

// Print what Slime generates and promotes, so a wrong answer can be fixed by rewording the intent (R9).
const config = await slimeConfigFromEnv(process.env, { onEvent: logEvent });
const slime = await createSlime(config);
// Off unless asked for: /dev/query lets any client generate a query (R8, R11).
const exposeDevQuery = process.env.SLIME_DEV_QUERY === '1';
// Off unless asked for: it writes Crystal modules into this app's source folder.
const crystallizer = process.env.SLIME_DEV_CRYSTALLIZE === '1' ? await devCrystallizer() : undefined;
const port = Number(process.env.PORT || DEFAULT_PORT);
const devRoutes = [exposeDevQuery && 'POST /dev/query', crystallizer && 'POST /dev/crystallize'].filter(Boolean);

const server = createApp(slime, { exposeDevQuery, ...(crystallizer ? { crystallizer } : {}) }).listen(port, () => {
  console.log(`Slime example on http://localhost:${port}${devRoutes.length > 0 ? ` (${devRoutes.join(', ')} enabled)` : ''}`);
});

async function devCrystallizer() {
  const optimizer = await optimizerFromEnv();
  return new Crystallizer(slime, { dir: CRYSTAL_DIR, ...(optimizer ? { optimizer } : {}) });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close();
    void slime.close();
  });
}

function logEvent(event) {
  if (event.type === 'generated') console.log(`[slime] generated ${event.handlerKey.slice(0, 12)}:\n  ${event.sql}\n  assumptions: ${event.assumptions.join(' | ') || 'none'}`);
  else if (event.type === 'reviewed') console.log(`[slime] review ${event.verdict}: ${event.notes || 'no problems'}`);
  else console.log(`[slime] ${event.type}: ${event.message ?? event.handlerKey}`);
}
