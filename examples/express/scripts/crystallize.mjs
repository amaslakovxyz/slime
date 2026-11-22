// Turns the Liquid handlers Slime saved in .slime/ into Crystal modules in
// slime-crystal/, with the same config the server uses. Commit the folder; CI runs
// `npm run check:crystal`, and the server serves it from then on (C10).
import { crystallize } from '@slime-cloud/core/crystallize';
import { databaseFromEnv } from '../src/config.mjs';

const CRYSTAL_DIR = new URL('../slime-crystal', import.meta.url).pathname;

const config = databaseFromEnv();
const optimizer = await chooseOptimizer(process.env);
try {
  const reports = await crystallize({ connector: config.connector, store: config.store, dir: CRYSTAL_DIR, ...(optimizer ? { optimizer } : {}) });
  for (const { intent, outcome, isOptimized, reasons } of reports) {
    console.log(`${outcome}${isOptimized ? ' (optimized)' : ''}: ${intent}${reasons.length > 0 ? `\n  ${reasons.join('\n  ')}` : ''}`);
  }
} finally {
  await config.connector.close();
}

/** Without a model key the Liquid code moves over unchanged, if it passes the allowlist. */
async function chooseOptimizer(env) {
  if (env.ANTHROPIC_API_KEY) {
    const { claude } = await import('@slime-cloud/core/claude');
    return claude.optimizer({ apiKey: env.ANTHROPIC_API_KEY, model: 'claude-opus-5-5' });
  }
  if (env.GROQ_API_KEY) {
    const { groq } = await import('@slime-cloud/core/groq');
    return groq.optimizer({ apiKey: env.GROQ_API_KEY, model: 'openai/gpt-oss-120b', reasoningEffort: 'high' });
  }
  return undefined;
}
