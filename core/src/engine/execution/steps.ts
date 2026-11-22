// Runs a handler (design §3.5): every step in parallel under one deadline,
// any failure aborts the API steps, then shape(data, input) in the sandbox.
import type { LimitOptions } from '../../config/options.js';
import type { Connector } from '../../sources/sql/types.js';
import { isApiStep, type ApiStep, type Artifact, type SqlStep, type Step } from '../../artifact/artifact.js';
import type { InputValues } from '../../request/parse.js';
import type { Shape } from '../../request/shape.js';
import { SlimeError } from '../../shared/errors.js';
import { SourceCallError, callSource } from '../../sources/api/call-source.js';
import { assertPlainRows } from '../../sources/api/plain-rows.js';
import { type ApiSchema } from '../../sources/api/types.js';
import { isApiSource, type Source } from '../../sources/types.js';
import { resolveArgs } from './step-args.js';

/** No sandbox: the caller's shaper decides where shape runs (Liquid in the sandbox, Crystal in-process or there). */
export interface StepsDeps {
  connector: Connector;
  limits: Readonly<LimitOptions>;
  sources: Readonly<Record<string, Source>>;
  apiSchemas: Readonly<Record<string, ApiSchema>>;
}

export interface StepsJob {
  artifact: Artifact;
  output: Shape;
  input: InputValues;
}

/** One step of a run, for meta.steps (R9). */
export interface StepTiming {
  name: string;
  source: string;
  rows: number;
  ms: number;
  sql?: string;
  operation?: string;
  args?: Record<string, unknown>;
}

export interface StepsExecution {
  data: unknown;
  truncated: boolean;
  runMs: number;
  shapeMs: number;
  steps: StepTiming[];
}

interface StepResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
  timing: StepTiming;
}

type Shaper = (data: unknown, job: StepsJob) => Promise<unknown>;

export async function executeSteps(deps: StepsDeps, job: StepsJob, shapeData: Shaper): Promise<StepsExecution> {
  const startedAt = performance.now();
  const results = await runAllSteps(deps, job);
  const runMs = performance.now() - startedAt;
  assertNotTruncated(job.artifact.steps, results);
  const data = Object.fromEntries(job.artifact.steps.map((step, index) => [step.name, results[index]!.rows]));
  const shapeStartedAt = performance.now();
  const shaped = job.artifact.shapeJs ? await shapeData(data, job) : results[0]!.rows;
  return { data: shaped, truncated: results.some((result) => result.truncated), runMs, shapeMs: job.artifact.shapeJs ? performance.now() - shapeStartedAt : 0, steps: results.map((result) => result.timing) };
}

async function runAllSteps(deps: StepsDeps, job: StepsJob): Promise<StepResult[]> {
  const controller = new AbortController();
  const deadlineMs = Math.max(deps.limits.statementTimeoutMs, deps.limits.apiTimeoutMs);
  // Promise.all rejects with the first failure; siblings aborted after it can't mask it.
  const steps = job.artifact.steps.map((step) =>
    runStep(deps, job, step, controller.signal).catch((error: unknown) => {
      controller.abort(error);
      throw error;
    }),
  );
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new SlimeError('EXECUTION_TIMEOUT', `The steps ran longer than ${deadlineMs} ms.`, { retryable: true });
      controller.abort(error);
      reject(error);
    }, deadlineMs);
  });
  try {
    return await Promise.race([Promise.all(steps), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function runStep(deps: StepsDeps, job: StepsJob, step: Step, signal: AbortSignal): Promise<StepResult> {
  return isApiStep(step) ? runApiStep(deps, job, step, signal) : runSqlStep(deps, job, step);
}

// Connector.run takes no signal: a running SQL step can't be cancelled, its result is discarded.
async function runSqlStep({ connector, limits }: StepsDeps, { input }: StepsJob, step: SqlStep): Promise<StepResult> {
  const startedAt = performance.now();
  const result = await connector.run(step.sql, step.params.map((name) => input[name] ?? null), { timeoutMs: limits.statementTimeoutMs, rowCap: limits.rowCap });
  const timing = { name: step.name, source: step.source, rows: result.rows.length, ms: performance.now() - startedAt, sql: step.sql };
  return { rows: result.rows, truncated: result.truncated, timing };
}

async function runApiStep({ sources, apiSchemas, limits }: StepsDeps, { input }: StepsJob, step: ApiStep, signal: AbortSignal): Promise<StepResult> {
  const source = sources[step.source];
  const operation = apiSchemas[step.source]?.operations.find(({ name }) => name === step.operation);
  if (!source || !isApiSource(source) || !operation) throw new SlimeError('INVALID_HANDLER', `Step "${step.name}" calls ${step.source} ${step.operation}, which is not configured.`);
  const args = resolveArgs(step, operation, input);
  const startedAt = performance.now();
  try {
    const result = await callSource({
      sourceName: step.source,
      method: 'call',
      secrets: source.secrets,
      timeoutMs: limits.apiTimeoutMs,
      signal,
      run: (options) => source.call(step.operation, args, { ...options, rowCap: limits.rowCap }),
    });
    assertPlainRows(result.rows, { stepName: step.name, sourceName: step.source });
    const timing = { name: step.name, source: step.source, rows: result.rows.length, ms: performance.now() - startedAt, operation: step.operation, args };
    return { rows: result.rows, truncated: result.truncated, timing };
  } catch (error) {
    throw error instanceof SourceCallError ? sourceError(error, step) : error;
  }
}

// MS7: one classification for every API failure; details carry no secrets.
function sourceError(error: SourceCallError, step: ApiStep): SlimeError {
  return new SlimeError('SOURCE_ERROR', error.message, {
    retryable: error.isRetryable,
    details: { source: step.source, operation: step.operation, status: error.status, attempts: error.attempts },
  });
}

// MS6: a cut-off step would make a combined answer wrong, not partial.
function assertNotTruncated(steps: readonly Step[], results: readonly StepResult[]): void {
  if (steps.length < 2) return;
  const truncatedIndex = results.findIndex((result) => result.truncated);
  if (truncatedIndex < 0) return;
  const stepName = steps[truncatedIndex]!.name;
  throw new SlimeError('QUERY_TOO_LARGE', `Step "${stepName}" reached the row cap, so a combined answer would be wrong; narrow the request.`, { details: { step: stepName } });
}
