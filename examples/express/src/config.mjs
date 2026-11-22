// Builds the SlimeConfig from this app's environment. Core never reads env; the app does.
import { existsSync } from 'node:fs';
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

/** A request no saved or Crystal handler answers is generated, so a model is required; tests pass their own `generator`. */
export async function slimeConfigFromEnv(env = process.env, overrides = {}) {
  const models = overrides.generator ? {} : await chooseModels(env);
  return new SlimeConfig({
    ...databaseFromEnv(env),
    glossary: GLOSSARY,
    rules: RULES,
    ...models,
    ...(await importCrystals()),
    ...overrides,
  });
}

/** The demo database and the handler store, without a model: enough for the crystallize job. */
export function databaseFromEnv(env = process.env) {
  return {
    // `||`, not `??`: an empty value copied from .env.example means unset.
    connector: postgresConnector({ url: env.DATABASE_URL || DEMO_DATABASE_URL }),
    store: fileStore(env.SLIME_STORE_DIR || `${APP_DIR}.slime`),
  };
}

/** A model key picks the provider. */
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
  throw new Error('Set GROQ_API_KEY or ANTHROPIC_API_KEY: Slime generates a handler for each new request with that model.');
}

/** Crystal handlers live in this app's code once `npm run crystallize` has written them (C10). */
async function importCrystals() {
  const index = `${APP_DIR}slime-crystal/index.mjs`;
  if (!existsSync(index)) return {};
  const { crystals } = await import(index);
  return { crystal: crystals };
}
