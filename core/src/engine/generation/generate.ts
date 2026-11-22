import type { Artifact, SqlStep } from '../../artifact/artifact.js';
import { lintSteps } from '../../artifact/checks/steps.js';
import type { ApiSchema } from '../../sources/api/types.js';
import type { Source } from '../../sources/types.js';
import type { LimitOptions } from '../../config/options.js';
import { SlimeError } from '../../shared/errors.js';
import type { Connector } from '../../sources/sql/types.js';
import type { Generator, ModelUsage } from '../../models/types.js';
import type { SandboxRunner } from '../../sandbox/types.js';
import type { HandlerProvenance } from '../../request/key.js';
import type { ParsedRequest } from '../../request/parse.js';
import { checkParamTypes, paramTypesForModel, type ParamTypes } from '../../request/params.js';
import { bindParams, executeArtifact, queryLimits, type Execution } from '../execution/execute.js';
import { repairMessage } from './repair-message.js';
import type { HandlerRecord } from '../../handler/record.js';
import { Trace } from '../trace.js';

export interface GenerationDeps {
  generator: Generator;
  connector: Connector;
  runner: SandboxRunner;
  limits: Readonly<LimitOptions>;
  dictionaryText: string;
  provenance: HandlerProvenance;
  sqlSourceName: string;
  sources: Readonly<Record<string, Source>>;
  apiSchemas: Readonly<Record<string, ApiSchema>>;
}

export interface GenerationJob {
  key: string;
  request: ParsedRequest;
  /** A revision starts from the rejected handler and the reviewer's notes. */
  previous?: PreviousAttempt;
  /** Set by the engine on a new request; a revision from the review loop passes none. */
  trace?: Trace;
}

export interface GenerationOutcome {
  record: HandlerRecord;
  execution: Execution;
  usage: ModelUsage;
}

export interface PreviousAttempt {
  artifact: Artifact;
  error: string;
}

// A repair with less time than this left would only time out.
const MIN_ATTEMPT_MS = 1_000;
const WRITE_LIKE_REASON = /\b(writ|delet|updat|insert|modif|chang|remov|creat)/i;
// Retrying can't make a write or a denied table allowed.
// MS7: the model can't fix a source outage. QUERY_TOO_LARGE stays repairable: a filter may fix it (MS6).
const FINAL_CODES = new Set(['WRITE_REFUSED', 'ACCESS_DENIED', 'SOURCE_ERROR']);

/** Generates, checks and runs a handler, repairing up to limits.maxRepairs times within the time budget. */
export async function generateHandler(deps: GenerationDeps, { key, request, previous: startingPoint, trace: jobTrace }: GenerationJob): Promise<GenerationOutcome> {
  const trace = jobTrace ?? new Trace();
  const paramTypes = checkParamTypes({}, request.input);
  const usage: ModelUsage = { ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 };
  let deadline = Date.now() + deps.limits.generationBudgetMs;
  let previous = startingPoint;
  let lastError: SlimeError | undefined;

  for (let attempt = 0; attempt <= deps.limits.maxRepairs && deadline - Date.now() >= MIN_ATTEMPT_MS; attempt++) {
    const attemptNo = attempt + 1;
    const generation = await trace.time(
      'generate',
      async () => {
        const result = await deps.generator.generate(
          { context: deps.dictionaryText, intent: request.intent, params: paramTypesForModel(paramTypes), output: request.output, ...(previous ? { previous } : {}) },
          { timeoutMs: deadline - Date.now() },
        );
        addUsage(usage, result);
        deadline += result.waitMs; // provider rate-limit waits don't count against the budget
        assertSatisfiable(result.artifact);
        return result;
      },
      { attempt: attemptNo, note: (g) => `${g.inputTokens + g.outputTokens} tokens` },
    );
    const { artifact } = generation;
    try {
      const execution = await tryArtifact(deps, artifact, request, trace, attemptNo);
      return { record: newRecord({ deps, key, request, artifact, paramTypes }), execution, usage };
    } catch (error) {
      lastError = asSlimeError(error);
      if (FINAL_CODES.has(lastError.code)) throw lastError;
      previous = { artifact, error: repairMessage(lastError) };
    }
  }
  throw lastError ?? new SlimeError('GENERATION_TIMEOUT', 'Ran out of generation time budget.', { retryable: true });
}

async function tryArtifact(deps: GenerationDeps, artifact: Artifact, request: ParsedRequest, trace: Trace, attempt: number): Promise<Execution> {
  const { sqlSourceName, apiSchemas } = deps;
  const stepCount = artifact.steps.length;
  await trace.time('lint', () => lintSteps(artifact, { sqlSourceName, apiSchemas, input: request.input, maxSteps: deps.limits.maxSteps }), {
    attempt,
    note: () => `read-only · params mapped · ${stepCount} step${stepCount === 1 ? '' : 's'}`,
  });
  const sqlSteps = artifact.steps.filter((step): step is SqlStep => 'sql' in step);
  if (sqlSteps.length === 0) trace.add('cost', 'skip', { note: 'no SQL steps', attempt });
  else {
    await trace.time(
      'cost',
      async () => {
        const costs: (number | null)[] = [];
        for (const step of sqlSteps) costs.push(await assertAffordable(deps, step.sql, bindParams(step.params, request.input)));
        return costs;
      },
      { attempt, note: (all) => `cost ${Math.max(0, ...all.map((c) => c ?? 0))} of ${deps.limits.maxQueryCost}` },
    );
  }
  try {
    const execution = await executeArtifact(deps, { artifact, output: request.output, input: request.input });
    trace.addExecution(execution, attempt);
    return execution;
  } catch (error) {
    trace.fail(error, attempt);
    throw error;
  }
}

async function assertAffordable(deps: GenerationDeps, sql: string, params: unknown[]): Promise<number | null> {
  const plan = await deps.connector.check(sql, params, queryLimits(deps.limits));
  if (plan.cost !== null && plan.cost > deps.limits.maxQueryCost) {
    throw new SlimeError('QUERY_TOO_EXPENSIVE', `Query cost ${plan.cost} is above the limit of ${deps.limits.maxQueryCost}.`);
  }
  return plan.cost;
}

function assertSatisfiable({ unsatisfiable }: Artifact): void {
  if (!unsatisfiable) return;
  const code = WRITE_LIKE_REASON.test(unsatisfiable) ? 'WRITE_REFUSED' : 'INTENT_UNSATISFIABLE';
  throw new SlimeError(code, unsatisfiable, { details: { enforcedBy: 'model' } });
}

interface NewRecordParts {
  deps: GenerationDeps;
  key: string;
  request: ParsedRequest;
  artifact: Artifact;
  paramTypes: ParamTypes;
}

function newRecord({ deps, key, request, artifact, paramTypes }: NewRecordParts): HandlerRecord {
  return {
    key,
    intent: request.intent,
    output: request.output,
    artifact,
    paramTypes,
    provenance: deps.provenance,
    tier: 'gas',
    review: 'none',
    runs: 1, // the generating request's own run passed every check
    fixtures: [structuredClone(request.input)],
    createdAt: new Date().toISOString(),
  };
}


function addUsage(total: ModelUsage, added: ModelUsage): void {
  total.ms += added.ms;
  total.waitMs += added.waitMs;
  total.inputTokens += added.inputTokens;
  total.outputTokens += added.outputTokens;
}

function asSlimeError(error: unknown): SlimeError {
  return error instanceof SlimeError ? error : new SlimeError('QUERY_ERROR', String(error));
}
