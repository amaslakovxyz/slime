import type { LimitOptions, TierOptions } from './options.js';

export const HOUR_MS = 60 * 60 * 1000;
export const MEBIBYTE = 1024 * 1024;

export const DEFAULT_TIERS: Readonly<TierOptions> = Object.freeze({
  gasToLiquidRuns: 3,
  gasWindowMs: HOUR_MS,
  maxReviews: 2,
  fixturesPerHandler: 5,
});

export const DEFAULT_LIMITS: Readonly<LimitOptions> = Object.freeze({
  maxRepairs: 1,
  generationBudgetMs: 25_000,
  reviewTimeoutMs: 60_000,
  maxConcurrentGenerations: 2,
  maxGenerationsPerHour: 200,
  statementTimeoutMs: 2_000,
  rowCap: 1_000,
  maxQueryCost: 1_000_000,
  shapeTimeoutMs: 200,
  shapeMemoryBytes: 32 * MEBIBYTE,
  maxSteps: 4,
  apiTimeoutMs: 10_000,
});
