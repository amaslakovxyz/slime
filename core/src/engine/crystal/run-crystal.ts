import { ARTIFACT_VERSION, type Artifact } from '../../artifact/artifact.js';
import { SlimeError } from '../../shared/errors.js';
import { assertValidOutput, bindParams, queryLimits, type Execution, type ExecutionDeps } from '../execution/execute.js';
import { executeSteps } from '../execution/steps.js';
import type { InputValues } from '../../request/parse.js';
import type { ShapeInput } from '../../sandbox/types.js';
import { isStepsCrystal, type CrystalHandler, type QueryCrystal, type StepsCrystal } from '../../handler/crystal.js';

/**
 * The runner is needed only for string shapes; function shapes never touch it. Sources and
 * their schemas only for a steps Crystal that calls API sources.
 */
export type CrystalDeps = Pick<ExecutionDeps, 'connector' | 'limits'> & Partial<Pick<ExecutionDeps, 'runner' | 'sources' | 'apiSchemas'>>;

type AnyShape = NonNullable<CrystalHandler['shape']>;

/**
 * Runs a Crystal handler: its SQL (or its steps, in parallel, as Liquid runs them), then its
 * shape. A function shape runs in this process (C10); a source string runs in the sandbox,
 * like Liquid code.
 */
export function runCrystal(deps: CrystalDeps, crystal: CrystalHandler, input: InputValues): Promise<Execution> {
  return isStepsCrystal(crystal) ? runStepsCrystal(deps, crystal, input) : runQueryCrystal(deps, crystal, input);
}

async function runQueryCrystal(deps: CrystalDeps, crystal: QueryCrystal, input: InputValues): Promise<Execution> {
  const result = await deps.connector.run(crystal.sql, bindParams(crystal.params, input), queryLimits(deps.limits));
  const shapeStartedAt = performance.now();
  const data = crystal.shape ? await runShape(deps, crystal.shape, result.rows, input) : result.rows;
  const shapeMs = crystal.shape ? performance.now() - shapeStartedAt : 0;
  assertValidOutput(crystal.output, data, input);
  return { data, truncated: result.truncated, runMs: result.ms, shapeMs };
}

async function runStepsCrystal(deps: CrystalDeps, crystal: StepsCrystal, input: InputValues): Promise<Execution> {
  const { shape } = crystal;
  // executeSteps reads only steps and whether there is a shape; the shaper below runs it.
  const artifact: Artifact = { version: ARTIFACT_VERSION, unsatisfiable: null, steps: [...crystal.steps], shapeJs: shape ? String(shape) : null, assumptions: [] };
  const stepsDeps = { connector: deps.connector, limits: deps.limits, sources: deps.sources ?? {}, apiSchemas: deps.apiSchemas ?? {} };
  const execution = await executeSteps(stepsDeps, { artifact, output: crystal.output, input }, (data) => runShape(deps, shape!, data, input));
  assertValidOutput(crystal.output, execution.data, input);
  return execution;
}

async function runShape({ runner, limits }: CrystalDeps, shape: AnyShape, data: unknown, input: InputValues): Promise<unknown> {
  if (typeof shape === 'function') return shapeInProcess(shape as (data: unknown, input: InputValues) => unknown, data, input);
  // A programming error in the host, not a request problem: the engine always passes its runner.
  if (!runner) throw new Error('runCrystal needs a sandbox runner for a Crystal whose shape is source text');
  return runner.run({ code: shape, rows: data as ShapeInput, input }, { timeoutMs: limits.shapeTimeoutMs, memoryBytes: limits.shapeMemoryBytes });
}

function shapeInProcess(shape: (data: unknown, input: InputValues) => unknown, data: unknown, input: InputValues): unknown {
  try {
    return shape(data, input);
  } catch (error) {
    throw new SlimeError('INVALID_HANDLER', `Crystal shape function threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}
