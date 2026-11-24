import type { Artifact } from '../../artifact/artifact.js';
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
}

export interface GenerationOutcome {
  record: HandlerRecord;
  execution: Execution;
  usage: ModelUsage;
  /** Model calls made, repairs included. */
  attempts: number;
  /** Checking attempts before the run that answered: every EXPLAIN, and the runs of failed attempts. */
  checksMs: number;
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
export async function generateHandler(deps: GenerationDeps, { key, request, previous: startingPoint }: GenerationJob): Promise<GenerationOutcome> {
  const paramTypes = checkParamTypes({}, request.input);
  const usage: ModelUsage = { ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 };
  let deadline = Date.now() + deps.limits.generationBudgetMs;
  let previous = startingPoint;
  let lastError: SlimeError | undefined;
  let attempts = 0;
  let checksMs = 0;

  for (let attempt = 0; attempt <= deps.limits.maxRepairs && deadline - Date.now() >= MIN_ATTEMPT_MS; attempt++) {
    attempts++;
    const generation = await deps.generator.generate(
      { context: deps.dictionaryText, intent: request.intent, params: paramTypesForModel(paramTypes), output: request.output, ...(previous ? { previous } : {}) },
      { timeoutMs: deadline - Date.now() },
    );
    addUsage(usage, generation);
    deadline += generation.waitMs; // waits between provider retries don't count against the budget
    assertSatisfiable(generation.artifact);
    const { artifact } = generation;
    const checkStartedAt = performance.now();
    try {
      await checkArtifact(deps, artifact, request);
      const runStartedAt = performance.now();
      checksMs += runStartedAt - checkStartedAt;
      const execution = await executeArtifact(deps, { artifact, output: request.output, input: request.input });
      return { record: newRecord({ deps, key, request, artifact, paramTypes }), execution, usage, attempts, checksMs };
    } catch (error) {
      // A failed attempt's checks and run are all checking time: the answer comes from a later one.
      checksMs += performance.now() - checkStartedAt;
      lastError = asSlimeError(error);
      if (FINAL_CODES.has(lastError.code)) throw lastError;
      previous = { artifact, error: repairMessage(lastError) };
    }
  }
  throw lastError ?? new SlimeError('GENERATION_TIMEOUT', 'Ran out of generation time budget.', { retryable: true });
}

/** The checks before an attempt runs: lint, then each SQL step's EXPLAIN cost. */
async function checkArtifact(deps: GenerationDeps, artifact: Artifact, request: ParsedRequest): Promise<void> {
  const { sqlSourceName, apiSchemas } = deps;
  lintSteps(artifact, { sqlSourceName, apiSchemas, input: request.input, maxSteps: deps.limits.maxSteps });
  for (const step of artifact.steps) {
    if (!('sql' in step)) continue;
    await assertAffordable(deps, step.sql, bindParams(step.params, request.input));
  }
}

async function assertAffordable(deps: GenerationDeps, sql: string, params: unknown[]): Promise<void> {
  const plan = await deps.connector.check(sql, params, queryLimits(deps.limits));
  if (plan.cost !== null && plan.cost > deps.limits.maxQueryCost) {
    throw new SlimeError('QUERY_TOO_EXPENSIVE', `Query cost ${plan.cost} is above the limit of ${deps.limits.maxQueryCost}.`);
  }
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
