// A Crystal as a plain function the app calls: its SQL through the connector, its
// shape in this process, then the output check. No engine, store or model (C10).
import { DEFAULT_LIMITS } from '../../config/defaults.js';
import type { LimitOptions } from '../../config/options.js';
import type { CrystalHandler } from '../../handler/crystal.js';
import type { InputValues } from '../../request/parse.js';
import { checkParamTypes } from '../../request/params.js';
import { SlimeError } from '../../shared/errors.js';
import type { Connector } from '../../sources/sql/types.js';
import { runCrystal } from './run-crystal.js';

export interface CrystalServiceOptions {
  /** statementTimeoutMs, rowCap and the rest; unset ones keep the defaults. */
  limits?: Partial<LimitOptions>;
}

export type CrystalService = (connector: Connector, input?: InputValues, options?: CrystalServiceOptions) => Promise<unknown>;

const STRING_SHAPE = 'a service needs the shape as a function: import it from the Crystal folder, not as source text';

export function crystalService(crystal: CrystalHandler): CrystalService {
  if (typeof crystal.shape === 'string') throw new TypeError(STRING_SHAPE);
  return async (connector, input = {}, { limits } = {}) => {
    assertKnownInputs(crystal, input);
    checkParamTypes(crystal.paramTypes, input);
    const execution = await runCrystal({ connector, limits: { ...DEFAULT_LIMITS, ...limits } }, crystal, input);
    return execution.data;
  };
}

// The request key fixes the input names; an unknown one is a caller's typo, not a filter (R5).
function assertKnownInputs({ paramTypes }: CrystalHandler, input: InputValues): void {
  const unknownNames = Object.keys(input).filter((name) => !(name in paramTypes));
  if (unknownNames.length === 0) return;
  throw new SlimeError('INVALID_REQUEST', `Unknown input ${unknownNames.join(', ')}; this Crystal takes ${Object.keys(paramTypes).join(', ') || 'no input'}.`);
}
