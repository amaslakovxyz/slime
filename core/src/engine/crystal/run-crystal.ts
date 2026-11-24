import { ARTIFACT_VERSION, type Artifact } from '../../artifact/artifact.js';
import { SlimeError } from '../../shared/errors.js';
import { assertValidOutput, bindParams, queryLimits, sandboxShaper, withoutSandboxWait, type Execution, type ExecutionDeps } from '../execution/execute.js';
import { executeSteps } from '../execution/steps.js';
import type { InputValues } from '../../request/parse.js';
import type { SandboxStats } from '../../sandbox/types.js';
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
  const shaper = crystal.shape ? crystalShaper(deps, crystal.shape, input) : undefined;
  const shapeStartedAt = performance.now();
  const data = shaper ? await shaper.shape(result.rows) : result.rows;
  const shapeMs = shaper ? performance.now() - shapeStartedAt : 0;
  assertValidOutput(crystal.output, data, input);
  return withoutSandboxWait({ data, truncated: result.truncated, runMs: result.ms, shapeMs }, shaper?.stats);
}

async function runStepsCrystal(deps: CrystalDeps, crystal: StepsCrystal, input: InputValues): Promise<Execution> {
  const { shape } = crystal;
  // executeSteps reads only steps and whether there is a shape; the shaper below runs it.
  const artifact: Artifact = { version: ARTIFACT_VERSION, unsatisfiable: null, steps: [...crystal.steps], shapeJs: shape ? String(shape) : null, assumptions: [] };
  const stepsDeps = { connector: deps.connector, limits: deps.limits, sources: deps.sources ?? {}, apiSchemas: deps.apiSchemas ?? {} };
  const shaper = shape ? crystalShaper(deps, shape, input) : undefined;
  const execution = withoutSandboxWait(await executeSteps(stepsDeps, { artifact, output: crystal.output, input }, (data) => shaper!.shape(data)), shaper?.stats);
  assertValidOutput(crystal.output, execution.data, input);
  return execution;
}

interface CrystalShaper {
  shape: (data: unknown) => Promise<unknown>;
  /** Only for a source-text shape, which runs in the sandbox. */
  stats?: SandboxStats;
}

function crystalShaper({ runner, limits }: CrystalDeps, shape: AnyShape, input: InputValues): CrystalShaper {
  if (typeof shape === 'function') return { shape: async (data) => shapeInProcess(shape as (data: unknown, input: InputValues) => unknown, data, input) };
  // A programming error in the host, not a request problem: the engine always passes its runner.
  if (!runner) throw new Error('runCrystal needs a sandbox runner for a Crystal whose shape is source text');
  return sandboxShaper({ runner, limits }, shape, input);
}

function shapeInProcess(shape: (data: unknown, input: InputValues) => unknown, data: unknown, input: InputValues): unknown {
  try {
    return shape(data, input);
  } catch (error) {
    throw new SlimeError('INVALID_HANDLER', `Crystal shape function threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}
