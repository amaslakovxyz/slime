// An API step's arguments for one run, type-checked on every run, not only the
// first: a handler made with null inputs learned no types (design §3.5).
import type { ApiStep } from '../artifact/artifact.js';
import type { InputValues } from '../request/parse.js';
import { matchesLeaf } from '../request/shape.js';
import { SlimeError } from '../shared/errors.js';
import type { OperationInfo } from '../sources/api/types.js';

export function resolveArgs(step: ApiStep, operation: OperationInfo, input: InputValues): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of step.args) {
    const param = operation.params.find(({ name }) => name === arg.param);
    if (!param) throw new SlimeError('INVALID_HANDLER', `Step "${step.name}": "${operation.name}" has no param "${arg.param}".`);
    const value = arg.input === null ? arg.value : (input[arg.input] ?? null);
    if (arg.input !== null && value !== null && (Array.isArray(value) || !matchesLeaf(param.type, value))) {
      throw new SlimeError('INVALID_REQUEST', `Input "${arg.input}" must be a ${param.type} (it is passed to ${step.source} ${operation.name} as "${param.name}").`);
    }
    args[param.name] = value;
  }
  return args;
}
