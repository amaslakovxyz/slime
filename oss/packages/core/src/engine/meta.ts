import type { SlimeMode } from '../config/options.js';
import { literalsInIntent } from '../request/parse.js';
import type { Execution } from './execute.js';
import type { CacheOutcome, QueryMeta, ReviewStatus, Tier } from './types.js';

export interface GeneratedCode {
  sql: string;
  shapeJs: string | null;
  assumptions: string[];
}

export interface MetaParts {
  handlerKey: string;
  tier: Tier;
  cache: CacheOutcome;
  review: ReviewStatus;
  execution: Execution;
  code: GeneratedCode;
  mode: SlimeMode;
  intent: string;
  totalMs: number;
  generateMs?: number;
}

const MS_PRECISION = 100;

export function queryMeta({ handlerKey, tier, cache, review, execution, code, mode, intent, totalMs, generateMs }: MetaParts): QueryMeta {
  const timingsMs = {
    total: roundMs(totalMs),
    run: roundMs(execution.runMs),
    shape: roundMs(execution.shapeMs),
    ...(generateMs === undefined ? {} : { generate: roundMs(generateMs) }),
  };
  const warnings = literalsInIntent(intent).map(literalWarning);
  return { handlerKey, tier, cache, truncated: execution.truncated, timingsMs, warnings, review, ...generatedCodeFor(mode, code) };
}

// R9, R11: generated code is shown in explore mode only.
function generatedCodeFor(mode: SlimeMode, { sql, shapeJs, assumptions }: GeneratedCode): Pick<QueryMeta, 'sql' | 'shapeJs' | 'assumptions'> {
  if (mode === 'locked') return {};
  return { sql, assumptions, ...(shapeJs ? { shapeJs } : {}) };
}

function literalWarning(label: string): string {
  return `The intent seems to contain ${label}; move the value into input so the handler serves other values too (R7).`;
}

function roundMs(ms: number): number {
  return Math.round(ms * MS_PRECISION) / MS_PRECISION;
}
