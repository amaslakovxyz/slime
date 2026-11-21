import { SlimeError } from '../../shared/errors.js';
import { assertValidOutput, bindParams, queryLimits, type Execution, type ExecutionDeps } from '../execute.js';
import type { InputValues } from '../../request/parse.js';
import type { CrystalHandler, ShapeFunction } from './types.js';

/** The runner is needed only for string shapes; function shapes never touch it. */
export type CrystalDeps = Omit<ExecutionDeps, 'runner'> & Partial<Pick<ExecutionDeps, 'runner'>>;

/**
 * Runs a Crystal handler: its SQL through the connector, then its shape. A function shape
 * runs in this process (C10); a source string runs in the sandbox, like Liquid code.
 */
export async function runCrystal(deps: CrystalDeps, crystal: CrystalHandler, input: InputValues): Promise<Execution> {
  const result = await deps.connector.run(crystal.sql, bindParams(crystal.params, input), queryLimits(deps.limits));
  const shapeStartedAt = performance.now();
  const data = crystal.shape ? await shapeRows(deps, crystal.shape, result.rows, input) : result.rows;
  const shapeMs = crystal.shape ? performance.now() - shapeStartedAt : 0;
  assertValidOutput(crystal.output, data, input);
  return { data, truncated: result.truncated, runMs: result.ms, shapeMs };
}

async function shapeRows(
  { runner, limits }: CrystalDeps,
  shape: NonNullable<CrystalHandler['shape']>,
  rows: Record<string, unknown>[],
  input: InputValues,
): Promise<unknown> {
  if (typeof shape === 'function') return shapeInProcess(shape, rows, input);
  // A programming error in the host, not a request problem: the engine always passes its runner.
  if (!runner) throw new Error('runCrystal needs a sandbox runner for a Crystal whose shape is source text');
  return runner.run({ code: shape, rows, input }, { timeoutMs: limits.shapeTimeoutMs, memoryBytes: limits.shapeMemoryBytes });
}

function shapeInProcess(shape: ShapeFunction, rows: Record<string, unknown>[], input: InputValues): unknown {
  try {
    return shape(rows, input);
  } catch (error) {
    throw new SlimeError('INVALID_HANDLER', `Crystal shape function threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}
