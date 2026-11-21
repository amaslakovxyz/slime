// SlimeConfig from the runtime's environment (SSM parameters become env vars at
// cold start, see lambda.ts). The core reads no env; this file is the mapping.
// Variable names are the sandbox's, so existing SSM parameters keep working.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SlimeConfig, type CrystalRegistry, type Generator, type LimitOptions, type Reviewer, type SlimeEvent, type TierOptions } from '@slime-cloud/core';
import { postgresConnector } from '@slime-cloud/core/postgres';
import { DynamoSlimeStore } from './store-dynamodb.js';

type Env = Readonly<Record<string, string | undefined>>;
type Effort = 'low' | 'medium' | 'high';

interface Models {
  generator?: Generator;
  reviewer?: Reviewer;
}

const DEMO_DATABASE_URL = 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const DEFAULT_OFFLINE_FILE = 'offline/handlers.json';
const CRYSTAL_INDEX = 'index.mjs';
const MEBIBYTE = 1024 * 1024;
const DEFAULT_MODELS = {
  claude: { generator: 'claude-haiku-5-5', reviewer: 'claude-opus-5-5' },
  groq: { generator: 'openai/gpt-oss-120b', reviewer: 'openai/gpt-oss-120b' },
} as const;

/** Env var → limit option; unset ones keep core's defaults. */
const LIMIT_VARIABLES: Readonly<Partial<Record<keyof LimitOptions, string>>> = {
  maxRepairs: 'MAX_REPAIRS',
  generationBudgetMs: 'GENERATION_BUDGET_MS',
  reviewTimeoutMs: 'REVIEW_TIMEOUT_MS',
  maxConcurrentGenerations: 'MAX_CONCURRENT_GENERATIONS',
  maxGenerationsPerHour: 'MAX_GENERATIONS_PER_HOUR',
  statementTimeoutMs: 'STATEMENT_TIMEOUT_MS',
  rowCap: 'ROW_CAP',
  maxQueryCost: 'MAX_QUERY_COST',
  shapeTimeoutMs: 'SHAPE_TIMEOUT_MS',
};

const TIER_VARIABLES: Readonly<Partial<Record<keyof TierOptions, string>>> = {
  gasToLiquidRuns: 'GAS_TO_LIQUID_HITS',
  gasWindowMs: 'GAS_WINDOW_MS',
  maxReviews: 'MAX_REVIEWS',
  fixturesPerHandler: 'FIXTURES_PER_HANDLER',
};

/** Runtime hooks that are not env settings (the Lambda entry counts generation tokens). */
export interface RuntimeHooks {
  onEvent?: (event: SlimeEvent) => void;
}

export async function slimeConfigFromEnv(env: Env = process.env, hooks: RuntimeHooks = {}): Promise<SlimeConfig> {
  const isLocked = env.SLIME_MODE === 'locked';
  const shapeMemoryMb = numberFrom(env.SHAPE_MEMORY_MB);
  return new SlimeConfig({
    connector: postgresConnector({ url: env.DATABASE_URL || DEMO_DATABASE_URL }),
    store: new DynamoSlimeStore({ table: env.SLIME_HANDLERS_TABLE ?? '', tenantId: env.SLIME_TENANT_ID ?? '' }),
    ...(isLocked ? {} : await modelsFrom(env)),
    ...(await crystalsFrom(env)),
    tiers: numbersFrom(env, TIER_VARIABLES),
    limits: { ...numbersFrom(env, LIMIT_VARIABLES), ...(shapeMemoryMb ? { shapeMemoryBytes: shapeMemoryMb * MEBIBYTE } : {}) },
    ...(hooks.onEvent ? { onEvent: hooks.onEvent } : {}),
  });
}

/** SLIME_PROVIDER picks claude (default), groq or offline; SLIME_REVIEW=off skips reviews. */
async function modelsFrom(env: Env): Promise<Models> {
  const provider = env.SLIME_PROVIDER === 'groq' || env.SLIME_PROVIDER === 'offline' ? env.SLIME_PROVIDER : 'claude';
  if (provider === 'offline') {
    const { offlineGenerator } = await import('@slime-cloud/core/offline');
    return { generator: offlineGenerator(JSON.parse(readFileSync(env.SLIME_OFFLINE_FILE || DEFAULT_OFFLINE_FILE, 'utf8'))) };
  }
  const isReviewing = env.SLIME_REVIEW !== 'off';
  const generatorModel = env.SLIME_MODEL || DEFAULT_MODELS[provider].generator;
  const reviewerModel = env.SLIME_REVIEW_MODEL || DEFAULT_MODELS[provider].reviewer;
  const generatorEffort = (env.SLIME_EFFORT || 'low') as Effort;
  const reviewerEffort = (env.SLIME_REVIEW_EFFORT || 'high') as Effort;
  if (provider === 'groq') {
    const { groq } = await import('@slime-cloud/core/groq');
    const apiKey = env.GROQ_API_KEY ?? '';
    return {
      generator: groq.generator({ apiKey, model: generatorModel, reasoningEffort: generatorEffort }),
      ...(isReviewing ? { reviewer: groq.reviewer({ apiKey, model: reviewerModel, reasoningEffort: reviewerEffort }) } : {}),
    };
  }
  const { claude } = await import('@slime-cloud/core/claude');
  const apiKey = env.ANTHROPIC_API_KEY ?? '';
  return {
    generator: claude.generator({ apiKey, model: generatorModel, effort: generatorEffort }),
    ...(isReviewing ? { reviewer: claude.reviewer({ apiKey, model: reviewerModel, effort: reviewerEffort }) } : {}),
  };
}

const PROVIDER_KEYS = { claude: 'ANTHROPIC_API_KEY', groq: 'GROQ_API_KEY' } as const;

/**
 * A warning when the provider that generates has no key: saved and Crystal handlers still
 * serve, but every new request would be sent to the provider with an empty key and fail.
 */
export function missingProviderKey(env: Env): string | undefined {
  if (env.SLIME_MODE === 'locked' || env.SLIME_PROVIDER === 'offline') return undefined;
  const name = PROVIDER_KEYS[env.SLIME_PROVIDER === 'groq' ? 'groq' : 'claude'];
  if (env[name]?.trim()) return undefined;
  return `${name} is not set: saved handlers still answer, new requests cannot be generated. Set it for the runtime (locally: export it before npm run local), or switch the endpoint to Offline.`;
}

/** Crystal ships in the bundle (SLIME_CRYSTAL_DIR); SLIME_CRYSTAL=off is the kill switch. */
async function crystalsFrom(env: Env): Promise<{ crystal?: CrystalRegistry }> {
  if (env.SLIME_CRYSTAL === 'off' || !env.SLIME_CRYSTAL_DIR) return {};
  const index = resolve(env.SLIME_CRYSTAL_DIR, CRYSTAL_INDEX);
  if (!existsSync(index)) return {};
  const { crystals } = (await import(pathToFileURL(index).href)) as { crystals: CrystalRegistry };
  return { crystal: crystals };
}

function numbersFrom<K extends string>(env: Env, variables: Readonly<Partial<Record<K, string>>>): Partial<Record<K, number>> {
  const entries = Object.entries(variables) as [K, string][];
  return Object.fromEntries(entries.flatMap(([option, variable]) => {
    const value = numberFrom(env[variable]);
    return value === undefined ? [] : [[option, value]];
  })) as Partial<Record<K, number>>;
}

function numberFrom(text: string | undefined): number | undefined {
  if (text === undefined || text === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}
