import { literalsInIntent } from '../request/parse.js';
import type { Execution } from './execution/execute.js';
import type { CacheOutcome, QueryMeta, QueryTimings } from './types.js';
import type { ReviewStatus, Tier } from '../handler/record.js';
import type { LayerSpan } from '../shared/trace.js';

export interface GeneratedCode {
  sql: string;
  shapeJs: string | null;
  assumptions: string[];
}

/** A miss's generation, for timingsMs and attempts. */
export interface GenerationTimings {
  modelMs: number;
  providerWaitMs: number;
  checksMs: number;
  attempts: number;
}

/** What happened before the run; each part is absent where it did not apply. */
export interface ResolveTimings {
  lookupMs?: number;
  queueMs?: number;
  generation?: GenerationTimings;
}

export interface MetaParts {
  handlerKey: string;
  tier: Tier;
  cache: CacheOutcome;
  review: ReviewStatus;
  execution: Execution;
  code: GeneratedCode;
  intent: string;
  totalMs: number;
  resolve?: ResolveTimings;
  trace?: LayerSpan[];
}

const MS_PRECISION = 100;
// Repeated in warnings so a client that only checks warnings still learns the data is incomplete.
const TRUNCATED_WARNING = 'The result was cut at the row cap, so data is incomplete; narrow the request or page it with limit and offset.';

export function queryMeta({ handlerKey, tier, cache, review, execution, code, intent, totalMs, resolve = {}, trace }: MetaParts): QueryMeta {
  const timingsMs = queryTimings(totalMs, resolve, execution);
  const warnings = literalsInIntent(intent).map(literalWarning);
  if (execution.truncated) warnings.push(TRUNCATED_WARNING);
  const steps = execution.steps ? { steps: execution.steps } : {};
  const attempts = resolve.generation ? { attempts: resolve.generation.attempts } : {};
  return { handlerKey, tier, cache, truncated: execution.truncated, timingsMs, ...attempts, warnings, review, ...steps, ...generatedCode(code), ...(trace ? { trace } : {}) };
}

// In the order the parts happen; total minus their sum is the engine's own bookkeeping.
function queryTimings(totalMs: number, { lookupMs, queueMs, generation }: ResolveTimings, execution: Execution): QueryTimings {
  return {
    total: roundMs(totalMs),
    ...optionalMs('lookup', lookupMs),
    ...optionalMs('queue', queueMs),
    ...(generation ? { generate: roundMs(generation.modelMs), providerWait: roundMs(generation.providerWaitMs), checks: roundMs(generation.checksMs) } : {}),
    run: roundMs(execution.runMs),
    ...optionalMs('sandboxWait', execution.sandboxWaitMs),
    shape: roundMs(execution.shapeMs),
  };
}

function optionalMs<Name extends string>(name: Name, ms: number | undefined): Partial<Record<Name, number>> {
  return ms === undefined ? {} : ({ [name]: roundMs(ms) } as Record<Name, number>);
}

// R9: the code that answered, so the caller can see what ran.
function generatedCode({ sql, shapeJs, assumptions }: GeneratedCode): Pick<QueryMeta, 'sql' | 'shapeJs' | 'assumptions'> {
  return { sql, assumptions, ...(shapeJs ? { shapeJs } : {}) };
}

function literalWarning(label: string): string {
  return `The intent seems to contain ${label}; move the value into input so the handler serves other values too (R7).`;
}

function roundMs(ms: number): number {
  return Math.round(ms * MS_PRECISION) / MS_PRECISION;
}
