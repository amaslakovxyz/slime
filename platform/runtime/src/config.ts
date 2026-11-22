// SlimeConfig from one endpoint's environment: the process env locally, or the
// env object the Lambda builds per tenant (tenants.ts). The core reads no env;
// this file is the mapping, and it reads only the env it is given.
// Variable names are the sandbox's, so existing SSM parameters keep working.
import {
  SlimeConfig,
  SlimeConfigError,
  type CrystalRegistry,
  type Generator,
  type LimitOptions,
  type Reviewer,
  type SlimeEvent,
  type TierOptions,
} from '@slime-cloud/core';
import { postgresConnector } from '@slime-cloud/core/postgres';
import { DynamoSlimeStore, type DocClient } from './store-dynamodb.js';

export type Env = Readonly<Record<string, string | undefined>>;
type Effort = 'low' | 'medium' | 'high';

interface Models {
  generator: Generator;
  reviewer?: Reviewer;
}

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
  // The engine's crystalReady threshold and Crystallize's minimum are the same number.
  crystalReadyRuns: 'CRYSTAL_MIN_RUNS',
};

/** What an endpoint's config needs besides env settings. */
export interface ConfigInputs {
  /** Sees engine events (usage counts generation tokens; warnings reach the log and the Lifecycle tab). */
  onEvent?: (event: SlimeEvent) => void;
  /** The endpoint's Crystals, loaded by its Crystal store (crystal-store.ts). SLIME_CRYSTAL=off ignores them. */
  crystal?: CrystalRegistry;
  /** Tests pass a fake DynamoDB for the handler store. */
  storeClient?: DocClient;
  /** Tests pass a fake generator (cannedGenerator); real endpoints use SLIME_PROVIDER. */
  generator?: Generator;
}

/**
 * Throws SlimeConfigError when DATABASE_URL is missing: an endpoint never falls back to
 * another database, so a tenant whose settings are incomplete fails closed.
 */
export async function slimeConfigFromEnv(env: Env, inputs: ConfigInputs = {}): Promise<SlimeConfig> {
  if (!env.DATABASE_URL) throw new SlimeConfigError(['DATABASE_URL is not set']);
  const shapeMemoryMb = numberFrom(env.SHAPE_MEMORY_MB);
  const maxConnections = numberFrom(env.SLIME_MAX_DB_CONNECTIONS);
  // The store first: its constructor can throw, and a connector built before it would leak its pool.
  const store = new DynamoSlimeStore({
    table: env.SLIME_HANDLERS_TABLE ?? '',
    tenantId: env.SLIME_TENANT_ID ?? '',
    ...(inputs.storeClient ? { client: inputs.storeClient } : {}),
  });
  const models = inputs.generator ? { generator: inputs.generator } : await modelsFrom(env);
  const hasCrystals = inputs.crystal && env.SLIME_CRYSTAL !== 'off';
  return new SlimeConfig({
    connector: postgresConnector({ url: env.DATABASE_URL, ...(maxConnections ? { maxConnections } : {}) }),
    store,
    ...models,
    ...(hasCrystals ? { crystal: inputs.crystal } : {}),
    tiers: numbersFrom(env, TIER_VARIABLES),
    limits: { ...numbersFrom(env, LIMIT_VARIABLES), ...(shapeMemoryMb ? { shapeMemoryBytes: shapeMemoryMb * MEBIBYTE } : {}) },
    ...(inputs.onEvent ? { onEvent: inputs.onEvent } : {}),
  });
}

/** SLIME_PROVIDER picks claude (default) or groq; SLIME_REVIEW=off skips reviews. */
async function modelsFrom(env: Env): Promise<Models> {
  const provider = env.SLIME_PROVIDER === 'groq' ? 'groq' : 'claude';
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
  const name = PROVIDER_KEYS[env.SLIME_PROVIDER === 'groq' ? 'groq' : 'claude'];
  if (env[name]?.trim()) return undefined;
  return `${name} is not set: saved handlers still answer, new requests cannot be generated. Set it for the runtime (locally: export it before npm run local).`;
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
