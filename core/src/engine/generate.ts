import { lintArtifact } from './checks/sql.js';
import type { LimitOptions } from '../config/options.js';
import { SlimeError } from '../shared/errors.js';
import type { Connector } from '../connectors/types.js';
import type { Artifact, Generator, ModelUsage, ParamTypesForModel } from '../models/types.js';
import type { SandboxRunner } from '../sandbox/types.js';
import type { HandlerProvenance } from '../request/key.js';
import type { ParsedRequest } from '../request/parse.js';
import { checkParamTypes, type ParamTypes } from '../request/params.js';
import { bindParams, executeArtifact, queryLimits, type Execution } from './execute.js';
import type { HandlerRecord } from './types.js';

export interface GenerationDeps {
  generator: Generator;
  connector: Connector;
  runner: SandboxRunner;
  limits: Readonly<LimitOptions>;
  dictionaryText: string;
  provenance: HandlerProvenance;
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
}

export interface PreviousAttempt {
  artifact: Artifact;
  error: string;
}

// A repair with less time than this left would only time out.
const MIN_ATTEMPT_MS = 1_000;
const WRITE_LIKE_REASON = /\b(writ|delet|updat|insert|modif|chang|remov|creat)/i;
// Retrying can't make a write or a denied table allowed.
const FINAL_CODES = new Set(['WRITE_REFUSED', 'ACCESS_DENIED']);

/** Generates, checks and runs a handler, repairing up to limits.maxRepairs times within the time budget. */
export async function generateHandler(deps: GenerationDeps, { key, request, previous: startingPoint }: GenerationJob): Promise<GenerationOutcome> {
  const paramTypes = checkParamTypes({}, request.input);
  const usage: ModelUsage = { ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 };
  let deadline = Date.now() + deps.limits.generationBudgetMs;
  let previous = startingPoint;
  let lastError: SlimeError | undefined;

  for (let attempt = 0; attempt <= deps.limits.maxRepairs && deadline - Date.now() >= MIN_ATTEMPT_MS; attempt++) {
    const generation = await deps.generator.generate(
      { context: deps.dictionaryText, intent: request.intent, params: forModel(paramTypes), output: request.output, ...(previous ? { previous } : {}) },
      { timeoutMs: deadline - Date.now() },
    );
    addUsage(usage, generation);
    deadline += generation.waitMs; // provider rate-limit waits don't count against the budget
    assertSatisfiable(generation.artifact);
    try {
      const execution = await tryArtifact(deps, generation.artifact, request);
      return { record: newRecord({ deps, key, request, artifact: generation.artifact, paramTypes }), execution, usage };
    } catch (error) {
      lastError = asSlimeError(error);
      if (FINAL_CODES.has(lastError.code)) throw lastError;
      previous = { artifact: generation.artifact, error: `${lastError.code}: ${lastError.message}` };
    }
  }
  throw lastError ?? new SlimeError('GENERATION_TIMEOUT', 'Ran out of generation time budget.', { retryable: true });
}

async function tryArtifact(deps: GenerationDeps, artifact: Artifact, request: ParsedRequest): Promise<Execution> {
  lintArtifact(artifact, request.input);
  const plan = await deps.connector.check(artifact.sql, bindParams(artifact.params, request.input), queryLimits(deps.limits));
  if (plan.cost > deps.limits.maxQueryCost) {
    throw new SlimeError('QUERY_TOO_EXPENSIVE', `Query cost ${plan.cost} is above the limit of ${deps.limits.maxQueryCost}.`);
  }
  return executeArtifact(deps, { artifact, output: request.output, input: request.input });
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

export function forModel(paramTypes: ParamTypes): ParamTypesForModel {
  return Object.fromEntries(Object.entries(paramTypes).map(([name, type]) => [name, type ?? 'unknown']));
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
