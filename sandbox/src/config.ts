// Loads sandbox/.env if present (Node 22 built-in), then reads typed settings.
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

export const config = {
  port: num('PORT', 3000),
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://slime_reader:slime_reader@localhost:54329/slime',
  // SLIME_MODE is read only from the environment, never from a request.
  // "locked": cache misses get 404 and the generator is never loaded.
  mode: (process.env.SLIME_MODE === 'locked' ? 'locked' : 'explore') as 'explore' | 'locked',
  // Which model provider writes handlers: "claude" (Anthropic API) or "groq" (free tier available).
  provider: (process.env.SLIME_PROVIDER === 'groq' ? 'groq' : 'claude') as 'claude' | 'groq',
  model:
    process.env.SLIME_MODEL ||
    (process.env.SLIME_PROVIDER === 'groq' ? 'openai/gpt-oss-120b' : 'claude-haiku-5-5'),
  effort: (process.env.SLIME_EFFORT ?? 'low') as 'low' | 'medium' | 'high',
  // Thinking adds latency; off by default for Gas speed. Set SLIME_THINKING=on to compare.
  thinking: process.env.SLIME_THINKING === 'on',

  // Background review before Gas may become Liquid (SLIME_REVIEW=off to skip).
  review: process.env.SLIME_REVIEW !== 'off',
  reviewModel:
    process.env.SLIME_REVIEW_MODEL ||
    (process.env.SLIME_PROVIDER === 'groq' ? 'openai/gpt-oss-120b' : 'claude-opus-5-5'),
  reviewEffort: (process.env.SLIME_REVIEW_EFFORT ?? 'high') as 'low' | 'medium' | 'high',
  // A rejected handler is regenerated with the reviewer's notes and reviewed again,
  // up to this many reviews in total.
  maxReviews: num('MAX_REVIEWS', 2),
  reviewTimeoutMs: num('REVIEW_TIMEOUT_MS', 60_000),

  // Tier rules (thresholds are TBD in the brief; these are starting values).
  gasToLiquidHits: num('GAS_TO_LIQUID_HITS', 3),
  gasWindowMs: num('GAS_WINDOW_MS', 60 * 60 * 1000),

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
} as const;
