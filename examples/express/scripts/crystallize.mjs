// Turns the Liquid handlers saved in .slime/ into Crystal modules in slime-crystal/,
// from the store alone. A handler's runs are saved at promotion and grow only in
// the server's memory after that, so prefer POST /dev/crystallize on the running
// server (SLIME_DEV_CRYSTALLIZE=1): it sees the live counts. Commit the folder; CI
// runs `npm run check:crystal`, and the server serves it from then on (C10).
import { crystallize } from '@slime-cloud/crystal';
import { CRYSTAL_DIR, databaseFromEnv, optimizerFromEnv } from '../src/config.mjs';

const config = databaseFromEnv();
const optimizer = await optimizerFromEnv();
try {
  const reports = await crystallize({ connector: config.connector, store: config.store, dir: CRYSTAL_DIR, ...(optimizer ? { optimizer } : {}) });
  for (const { intent, outcome, isOptimized, reasons } of reports) {
    console.log(`${outcome}${isOptimized ? ' (optimized)' : ''}: ${intent}${reasons.length > 0 ? `\n  ${reasons.join('\n  ')}` : ''}`);
  }
} finally {
  await config.connector.close();
}
