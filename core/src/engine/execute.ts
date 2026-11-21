import { assertWithinLimit } from './checks/limit.js';
import type { LimitOptions } from '../config/options.js';
import { SlimeError } from '../shared/errors.js';
import type { Connector, QueryLimits } from '../connectors/types.js';
import { isArtifactV2, type AnyArtifact, type ArtifactV2 } from '../models/artifact-v2.js';
import type { SandboxRunner, ShapeInput } from '../sandbox/types.js';
import type { ApiSchema, Source } from '../sources/types.js';
import { executeSteps, type StepTiming } from './execute-steps.js';
import type { InputValues } from '../request/parse.js';
import { validateData, type Shape } from '../request/shape.js';

export interface ExecutionDeps {
  connector: Connector;
  runner: SandboxRunner;
  limits: Readonly<LimitOptions>;
  /** Needed only by v2 handlers (MS3). */
  sources?: Readonly<Record<string, Source>>;
  apiSchemas?: Readonly<Record<string, ApiSchema>>;
}

export interface ExecutionJob {
  artifact: AnyArtifact;
  output: Shape;
  input: InputValues;
}

export interface Execution {
  data: unknown;
  truncated: boolean;
  runMs: number;
  shapeMs: number;
  /** v2 only. */
  steps?: StepTiming[];
}

export async function executeArtifact(deps: ExecutionDeps, job: ExecutionJob): Promise<Execution> {
  if (isArtifactV2(job.artifact)) return executeV2(deps, job.artifact, job);
  const { connector, runner, limits } = deps;
  const { artifact, output, input } = job;
  const result = await connector.run(artifact.sql, bindParams(artifact.params, input), queryLimits(limits));
  const shapeStartedAt = performance.now();
  const data = artifact.shapeJs
    ? await runner.run({ code: artifact.shapeJs, rows: result.rows, input }, { timeoutMs: limits.shapeTimeoutMs, memoryBytes: limits.shapeMemoryBytes })
    : result.rows;
  const shapeMs = artifact.shapeJs ? performance.now() - shapeStartedAt : 0;

  assertValidOutput(output, data, input);
  return { data, truncated: result.truncated, runMs: result.ms, shapeMs };
}

async function executeV2(deps: ExecutionDeps, artifact: ArtifactV2, { output, input }: ExecutionJob): Promise<Execution> {
  const { connector, runner, limits, sources, apiSchemas } = deps;
  if (!sources || !apiSchemas) throw new SlimeError('INVALID_HANDLER', 'A multi-source handler needs the configured sources.');
  const shapeLimits = { timeoutMs: limits.shapeTimeoutMs, memoryBytes: limits.shapeMemoryBytes };
  const shapeData = (data: unknown): Promise<unknown> => runner.run({ code: artifact.shapeJs ?? '', rows: data as ShapeInput, input }, shapeLimits);
  const execution = await executeSteps({ connector, runner, limits, sources, apiSchemas }, { artifact, output, input }, shapeData);
  assertValidOutput(output, execution.data, input, true); // MS15: no values in the mismatch text
  return execution;
}

/** The checks every handler's result must pass, whatever tier ran it: the output shape and R6. */
export function assertValidOutput(output: Shape, data: unknown, input: InputValues, isValueFree = false): void {
  const mismatches = validateData(output, data, { isValueFree });
  if (mismatches.length > 0) {
    throw new SlimeError('SHAPE_MISMATCH', `Result does not match the requested output: ${mismatches.join('; ')}`, { details: { mismatches } });
  }
  assertWithinLimit(data, input);
}

/** A parameter that is missing from the input is bound as null: "not given" (R5). */
export function bindParams(paramNames: readonly string[], input: InputValues): unknown[] {
  return paramNames.map((name) => input[name] ?? null);
}

export function queryLimits(limits: Readonly<LimitOptions>): QueryLimits {
  return { timeoutMs: limits.statementTimeoutMs, rowCap: limits.rowCap };
}
