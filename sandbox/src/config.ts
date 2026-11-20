// Loads sandbox/.env if present (Node 22 built-in), then reads typed settings.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // No .env file: rely on the real environment.
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

export type Provider = 'claude' | 'groq' | 'offline';

function provider(): Provider {
  const p = process.env.SLIME_PROVIDER;
  return p === 'groq' || p === 'offline' ? p : 'claude';
}

const DEFAULT_MODEL: Record<Provider, string> = {
  claude: 'claude-haiku-5-5',
  groq: 'openai/gpt-oss-120b',
  offline: 'offline',
};
const DEFAULT_REVIEW_MODEL: Record<Provider, string> = {
  claude: 'claude-opus-5-5',
  groq: 'openai/gpt-oss-120b',
  offline: 'offline',
};

// Mutable on purpose: tests adjust thresholds and limits per case.
export const config = {
  port: num('PORT', 3000),
  // Generated SQL runs as this read-only user.
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://slime_reader:slime_reader@localhost:54329/slime',
  // Slime's own storage (Liquid handlers) uses a separate user that owns only the
  // slime_meta schema. Set to "" to keep everything in memory.
  metaDatabaseUrl:
    process.env.META_DATABASE_URL ?? 'postgres://slime_writer:slime_writer@localhost:54329/slime',
  // Table inside slime_meta. The demo script uses its own so it never touches dev data.
  metaTable: process.env.SLIME_META_TABLE || 'handlers',
  // SLIME_MODE is read only from the environment, never from a request.
  // "locked": cache misses get 404 and the generator is never loaded.
  mode: (process.env.SLIME_MODE === 'locked' ? 'locked' : 'explore') as 'explore' | 'locked',
  // Which model provider writes handlers: "claude" (Anthropic API), "groq" (free tier
  // available) or "offline" (canned handlers from a file; no API key, used by tests).
  provider: provider(),
  model: process.env.SLIME_MODEL || DEFAULT_MODEL[provider()],
  offlineHandlersFile: process.env.SLIME_OFFLINE_FILE ?? 'offline/handlers.json',
  effort: (process.env.SLIME_EFFORT ?? 'low') as 'low' | 'medium' | 'high',
  // Thinking adds latency; off by default for Gas speed. Set SLIME_THINKING=on to compare.
  thinking: process.env.SLIME_THINKING === 'on',

  // Background review before Gas may become Liquid (SLIME_REVIEW=off to skip).
  review: process.env.SLIME_REVIEW !== 'off',
  reviewModel: process.env.SLIME_REVIEW_MODEL || DEFAULT_REVIEW_MODEL[provider()],
  reviewEffort: (process.env.SLIME_REVIEW_EFFORT ?? 'high') as 'low' | 'medium' | 'high',
  // A rejected handler is regenerated with the reviewer's notes and reviewed again,
  // up to this many reviews in total.
  maxReviews: num('MAX_REVIEWS', 2),
  reviewTimeoutMs: num('REVIEW_TIMEOUT_MS', 60_000),

  // Tier rules (thresholds are TBD in the brief; these are starting values).
  // Promotion counts successful runs, not lookups: a handler that keeps failing
  // for some inputs doesn't earn Liquid by being asked often.
  gasToLiquidHits: num('GAS_TO_LIQUID_HITS', 3),
  gasWindowMs: num('GAS_WINDOW_MS', 60 * 60 * 1000),
  // Successful runs recorded per handler (distinct inputs). They are stored with
  // Liquid handlers and are what Crystal's equivalence test replays.
  fixturesPerHandler: num('FIXTURES_PER_HANDLER', 5),

  // Crystal: handlers an agent rewrote into plain modules in a folder in git
  // (`npm run crystallize`). Core loads them at startup and runs them without
  // the sandbox worker. SLIME_CRYSTAL=off is the kill switch.
  crystal: process.env.SLIME_CRYSTAL !== 'off',
  crystalDir: process.env.SLIME_CRYSTAL_DIR
    ? resolve(process.env.SLIME_CRYSTAL_DIR)
    : fileURLToPath(new URL('../crystal', import.meta.url)),
  // A Liquid handler needs this many successful runs before it is crystallized.
  crystalMinRuns: num('CRYSTAL_MIN_RUNS', 10),

  // Generation limits.
  maxRepairs: num('MAX_REPAIRS', 1),
  generationBudgetMs: num('GENERATION_BUDGET_MS', 25_000),
  maxConcurrentGenerations: num('MAX_CONCURRENT_GENERATIONS', 2),
  maxGenerationsPerHour: num('MAX_GENERATIONS_PER_HOUR', 200),

  // Query limits.
  statementTimeoutMs: num('STATEMENT_TIMEOUT_MS', 2_000),
  rowCap: num('ROW_CAP', 1_000),
  maxQueryCost: num('MAX_QUERY_COST', 1_000_000),

  // Sandbox limits for the shaping function.
  shapeTimeoutMs: num('SHAPE_TIMEOUT_MS', 200),
  shapeMemoryBytes: num('SHAPE_MEMORY_MB', 32) * 1024 * 1024,
};
