// Builds the SlimeConfig from this app's environment. Core never reads env; the app does.
import { existsSync, readFileSync } from 'node:fs';
import { SlimeConfig, fileStore } from '@slime-cloud/core';
import { postgresConnector } from '@slime-cloud/core/postgres';

const APP_DIR = new URL('..', import.meta.url).pathname;
const DEMO_DATABASE_URL = 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const CLAUDE_GENERATOR_MODEL = 'claude-haiku-5-5';
const CLAUDE_REVIEW_MODEL = 'claude-opus-5-5';

/** The app's own meaning of words and its rules for generated SQL (§4.4). */
const GLOSSARY = { revenue: 'sum of paid invoices, in cents' };
const RULES = ['Revenue counts only invoices with status paid.'];

/**
 * Explore mode generates new handlers (development); locked mode serves only
 * saved and Crystal handlers (production, R8). SLIME_LOCKED=1 locks it.
 */
export async function slimeConfigFromEnv(env = process.env, overrides = {}) {
  const models = env.SLIME_LOCKED === '1' ? {} : await chooseModels(env);
  return new SlimeConfig({
    connector: postgresConnector({ url: env.DATABASE_URL ?? DEMO_DATABASE_URL }),
    store: fileStore(env.SLIME_STORE_DIR ?? `${APP_DIR}.slime`),
    glossary: GLOSSARY,
    rules: RULES,
    ...models,
    ...(await importCrystals()),
    ...overrides,
  });
}

/** A model key picks a provider; without one, the offline handlers stand in for a model. */
async function chooseModels(env) {
  if (env.GROQ_API_KEY) {
    const { groq } = await import('@slime-cloud/core/groq');
    const options = { apiKey: env.GROQ_API_KEY, model: GROQ_MODEL };
    return { generator: groq.generator({ ...options, reasoningEffort: 'low' }), reviewer: groq.reviewer({ ...options, reasoningEffort: 'high' }) };
  }
  if (env.ANTHROPIC_API_KEY) {
    const { claude } = await import('@slime-cloud/core/claude');
    const apiKey = env.ANTHROPIC_API_KEY;
    return { generator: claude.generator({ apiKey, model: CLAUDE_GENERATOR_MODEL }), reviewer: claude.reviewer({ apiKey, model: CLAUDE_REVIEW_MODEL }) };
  }
  const { offlineGenerator } = await import('@slime-cloud/core/offline');
  return { generator: offlineGenerator(JSON.parse(readFileSync(`${APP_DIR}offline-handlers.json`, 'utf8'))) };
}

/** Crystal handlers live in this app's code once `npm run crystallize` has written them (C10). */
async function importCrystals() {
  const index = `${APP_DIR}slime-crystal/index.mjs`;
  if (!existsSync(index)) return {};
  const { crystals } = await import(index);
  return { crystal: crystals };
}
