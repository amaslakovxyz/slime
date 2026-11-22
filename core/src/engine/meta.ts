import { literalsInIntent } from '../request/parse.js';
import type { Execution } from './execution/execute.js';
import type { CacheOutcome, QueryMeta } from './types.js';
import type { ReviewStatus, Tier } from '../handler/record.js';

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
  intent: string;
  totalMs: number;
  generateMs?: number;
}

const MS_PRECISION = 100;
// Repeated in warnings so a client that only checks warnings still learns the data is incomplete.
const TRUNCATED_WARNING = 'The result was cut at the row cap, so data is incomplete; narrow the request or page it with limit and offset.';

export function queryMeta({ handlerKey, tier, cache, review, execution, code, intent, totalMs, generateMs }: MetaParts): QueryMeta {
  const timingsMs = {
    total: roundMs(totalMs),
    run: roundMs(execution.runMs),
    shape: roundMs(execution.shapeMs),
    ...(generateMs === undefined ? {} : { generate: roundMs(generateMs) }),
  };
  const warnings = literalsInIntent(intent).map(literalWarning);
  if (execution.truncated) warnings.push(TRUNCATED_WARNING);
  const steps = execution.steps ? { steps: execution.steps } : {};
  return { handlerKey, tier, cache, truncated: execution.truncated, timingsMs, warnings, review, ...steps, ...generatedCode(code) };
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
