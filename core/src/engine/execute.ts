import { assertWithinLimit } from './checks/limit.js';
import type { LimitOptions } from '../config/options.js';
import { SlimeError } from '../shared/errors.js';
import type { Connector, QueryLimits } from '../connectors/types.js';
import { asV1, type AnyArtifact } from '../models/artifact-v2.js';
import type { SandboxRunner } from '../sandbox/types.js';
import type { InputValues } from '../request/parse.js';
import { validateData, type Shape } from '../request/shape.js';

export interface ExecutionDeps {
  connector: Connector;
  runner: SandboxRunner;
  limits: Readonly<LimitOptions>;
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
}

export async function executeArtifact({ connector, runner, limits }: ExecutionDeps, job: ExecutionJob): Promise<Execution> {
  const { output, input } = job;
  const artifact = asV1(job.artifact, 'the executor'); // MS3: P2.7 adds the step executor
  const result = await connector.run(artifact.sql, bindParams(artifact.params, input), queryLimits(limits));
  const shapeStartedAt = performance.now();
  const data = artifact.shapeJs
    ? await runner.run({ code: artifact.shapeJs, rows: result.rows, input }, { timeoutMs: limits.shapeTimeoutMs, memoryBytes: limits.shapeMemoryBytes })
    : result.rows;
  const shapeMs = artifact.shapeJs ? performance.now() - shapeStartedAt : 0;

  assertValidOutput(output, data, input);
  return { data, truncated: result.truncated, runMs: result.ms, shapeMs };
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
