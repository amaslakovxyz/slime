import { isPlainObject } from '../shared/guards.js';
import { MEBIBYTE } from './defaults.js';
import type { LimitOptions, TierOptions } from './options.js';

interface NumberRules {
  minimums: Readonly<Record<string, number>>;
  /** Every other key must be an integer. */
  fractionalKeys: readonly string[];
}

const TIER_MINIMUMS: Record<keyof TierOptions, number> = {
  gasToLiquidRuns: 1,
  gasWindowMs: 1,
  maxReviews: 1,
  fixturesPerHandler: 0,
  crystalReadyRuns: 1,
};

const LIMIT_MINIMUMS: Record<keyof LimitOptions, number> = {
  maxRepairs: 0,
  generationBudgetMs: 1,
  reviewTimeoutMs: 1,
  maxConcurrentGenerations: 1,
  maxGenerationsPerHour: 1,
  statementTimeoutMs: 1,
  rowCap: 1,
  maxQueryCost: 1,
  shapeTimeoutMs: 1,
  shapeMemoryBytes: MEBIBYTE,
  maxSteps: 1,
  apiTimeoutMs: 100,
};

const RULES_BY_SECTION = {
  tiers: { minimums: TIER_MINIMUMS, fractionalKeys: [] },
  limits: { minimums: LIMIT_MINIMUMS, fractionalKeys: ['maxQueryCost'] },
} as const satisfies Record<string, NumberRules>;

export type NumberSection = keyof typeof RULES_BY_SECTION;

export function numberProblems(section: NumberSection, settings: unknown): string[] {
  if (settings === undefined) return [];
  if (!isPlainObject(settings)) return [`${section} must be an object`];

  const { minimums, fractionalKeys }: NumberRules = RULES_BY_SECTION[section];
  const problems: string[] = [];
  for (const [key, setting] of Object.entries(settings)) {
    const minimum = minimums[key];
    if (minimum === undefined) {
      problems.push(`unknown option ${section}.${key} (allowed: ${Object.keys(minimums).join(', ')})`);
      continue;
    }
    const allowsFraction = fractionalKeys.includes(key);
    if (!isNumberAtLeast(setting, minimum, allowsFraction)) {
      problems.push(`${section}.${key} must be ${allowsFraction ? 'a number' : 'an integer'} of at least ${minimum}`);
    }
  }
  return problems;
}

function isNumberAtLeast(value: unknown, minimum: number, allowsFraction: boolean): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return (allowsFraction || Number.isInteger(value)) && value >= minimum;
}
