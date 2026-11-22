import { assertWithinLimit } from './output-limit.js';
import type { LimitOptions } from '../../config/options.js';
import { SlimeError } from '../../shared/errors.js';
import type { Connector, QueryLimits } from '../../sources/sql/types.js';
import type { Artifact } from '../../artifact/artifact.js';
import type { SandboxRunner, ShapeInput } from '../../sandbox/types.js';
import type { ApiSchema } from '../../sources/api/types.js';
import type { Source } from '../../sources/types.js';
import { executeSteps, type StepTiming } from './steps.js';
import type { InputValues } from '../../request/parse.js';
import { validateData, type Shape } from '../../request/shape.js';

export interface ExecutionDeps {
  connector: Connector;
  runner: SandboxRunner;
  limits: Readonly<LimitOptions>;
  sources: Readonly<Record<string, Source>>;
  apiSchemas: Readonly<Record<string, ApiSchema>>;
}

export interface ExecutionJob {
  artifact: Artifact;
  output: Shape;
  input: InputValues;
}

export interface Execution {
  data: unknown;
  truncated: boolean;
  runMs: number;
  shapeMs: number;
  /** Absent for Crystal, which runs one query. */
  steps?: StepTiming[];
}

export async function executeArtifact(deps: ExecutionDeps, { artifact, output, input }: ExecutionJob): Promise<Execution> {
  const { runner, limits } = deps;
  const shapeLimits = { timeoutMs: limits.shapeTimeoutMs, memoryBytes: limits.shapeMemoryBytes };
  const shapeData = (data: unknown): Promise<unknown> => runner.run({ code: artifact.shapeJs ?? '', rows: data as ShapeInput, input }, shapeLimits);
  const execution = await executeSteps(deps, { artifact, output, input }, shapeData);
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
