import { SlimeError } from '../../shared/errors.js';
import { assertValidOutput, bindParams, queryLimits, type Execution, type ExecutionDeps } from '../execute.js';
import type { InputValues } from '../../request/parse.js';
import type { CrystalHandler } from './types.js';

export type CrystalDeps = Omit<ExecutionDeps, 'runner'>;

/** Runs a Crystal handler: its SQL through the connector, its shape function in this process (C10). */
export async function runCrystal({ connector, limits }: CrystalDeps, crystal: CrystalHandler, input: InputValues): Promise<Execution> {
  const result = await connector.run(crystal.sql, bindParams(crystal.params, input), queryLimits(limits));
  const shapeStartedAt = performance.now();
  const data = crystal.shape ? shapeInProcess(crystal.shape, result.rows, input) : result.rows;
  const shapeMs = crystal.shape ? performance.now() - shapeStartedAt : 0;
  assertValidOutput(crystal.output, data, input);
  return { data, truncated: result.truncated, runMs: result.ms, shapeMs };
}

function shapeInProcess(shape: NonNullable<CrystalHandler['shape']>, rows: Record<string, unknown>[], input: InputValues): unknown {
  try {
    return shape(rows, input);
  } catch (error) {
    throw new SlimeError('INVALID_HANDLER', `Crystal shape function threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}
