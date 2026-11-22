import { createSlime } from '@slime-cloud/core';
import { Crystallizer } from '@slime-cloud/crystal';
import { createApp } from './app.mjs';
import { CRYSTAL_DIR, optimizerFromEnv, slimeConfigFromEnv } from './config.mjs';

const DEFAULT_PORT = 3000;

// Print what Slime generates and promotes, so a wrong answer can be fixed by rewording the intent (R9).
const config = await slimeConfigFromEnv(process.env, { onEvent: logEvent });
const slime = await createSlime(config);
// Crystallize writes Crystal modules into this app's source folder (slime-crystal/); commit them.
const optimizer = await optimizerFromEnv();
const crystallizer = new Crystallizer(slime, { dir: CRYSTAL_DIR, ...(optimizer ? { optimizer } : {}) });
const port = Number(process.env.PORT || DEFAULT_PORT);

const server = createApp(slime, crystallizer).listen(port, () => {
  console.log(`Slime example on http://localhost:${port} (POST /query, POST /crystallize, GET /health)`);
});

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
