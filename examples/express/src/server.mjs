import { createSlime } from '@slime-cloud/core';
import { createApp } from './app.mjs';
import { slimeConfigFromEnv } from './config.mjs';

const DEFAULT_PORT = 3000;

// Print what Slime generates and promotes, so a wrong answer can be fixed by rewording the intent (R9).
const config = await slimeConfigFromEnv(process.env, { onEvent: logEvent });
const slime = await createSlime(config);
const isExplore = config.mode === 'explore';
const port = Number(process.env.PORT || DEFAULT_PORT);

const server = createApp(slime, { exposeDevQuery: isExplore }).listen(port, () => {
  console.log(`Slime example on http://localhost:${port} (${config.mode} mode${isExplore ? ', POST /dev/query enabled' : ''})`);
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
