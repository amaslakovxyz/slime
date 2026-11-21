// Model-free checks of a v2 handler's steps (design §3.5). Pure, and needs only
// input names, so it also runs when a saved handler is loaded (MS14).
import { isApiStep, type ApiArg, type ApiStep, type ArtifactV2, type SqlStep } from '../../models/artifact-v2.js';
import { matchesLeaf } from '../../request/shape.js';
import { SlimeError } from '../../shared/errors.js';
import type { ApiSchema, OperationInfo, ParamInfo } from '../../sources/types.js';
import { MIN_HARDCODED_LENGTH, lintArtifact } from './sql.js';

export interface StepLintContext {
  sqlSourceName: string;
  apiSchemas: Readonly<Record<string, ApiSchema>>;
  /** Request input; at load time only the names matter and values may be null. */
  input: Readonly<Record<string, unknown>>;
  maxSteps: number;
}

const STEP_NAME = /^[a-z][A-Za-z0-9]*$/;

export function lintSteps(artifact: ArtifactV2, context: StepLintContext): void {
  const { steps } = artifact;
  if (steps.length < 1 || steps.length > context.maxSteps) throw invalidHandler(`A handler has 1 to ${context.maxSteps} steps; this one has ${steps.length}.`);
  const names = new Set<string>();
  for (const step of steps) {
    if (!STEP_NAME.test(step.name)) throw invalidHandler(`Step name "${step.name}" must start with a lowercase letter and have only letters and digits.`);
    if (names.has(step.name)) throw invalidHandler(`Step name "${step.name}" is used twice.`);
    names.add(step.name);
    if (isApiStep(step)) lintApiStep(step, context);
    else lintSqlStep(step, artifact, context);
  }
  if (steps.length > 1 && !artifact.shapeJs) throw invalidHandler('A handler with more than one step needs shapeJs to combine them.');
}

function lintSqlStep(step: SqlStep, { shapeJs }: ArtifactV2, context: StepLintContext): void {
  if (step.source !== context.sqlSourceName) {
    const isApi = step.source in context.apiSchemas;
    throw invalidHandler(isApi ? `Step "${step.name}" is SQL but "${step.source}" is an API source.` : `Step "${step.name}" names an unknown source "${step.source}".`);
  }
  lintArtifact({ sql: step.sql, params: step.params, shapeJs }, context.input);
}

function lintApiStep(step: ApiStep, context: StepLintContext): void {
  const schema = context.apiSchemas[step.source];
  if (!schema) {
    const isSql = step.source === context.sqlSourceName;
    throw invalidHandler(isSql ? `Step "${step.name}" calls an operation but "${step.source}" is the SQL source.` : `Step "${step.name}" names an unknown source "${step.source}".`);
  }
  const operation = schema.operations.find(({ name }) => name === step.operation);
  if (!operation) throw invalidHandler(`Source "${step.source}" has no operation "${step.operation}".`);
  const bound = new Set<string>();
  for (const arg of step.args) {
    if (bound.has(arg.param)) throw invalidHandler(`Step "${step.name}" binds "${arg.param}" twice.`);
    bound.add(arg.param);
    lintArg(step, operation, arg, context.input);
  }
}

function lintArg(step: ApiStep, operation: OperationInfo, arg: ApiArg, input: Readonly<Record<string, unknown>>): void {
  const where = `Step "${step.name}", param "${arg.param}"`;
  const param = operation.params.find(({ name }) => name === arg.param);
  if (!param) throw invalidHandler(`${where}: "${operation.name}" has no such param.`);
  if ((arg.input === null) === (arg.value === null)) throw invalidHandler(`${where}: set exactly one of input and value.`);
  if (arg.input !== null) {
    if (!(arg.input in input)) throw invalidHandler(`${where}: "${arg.input}" is not an input name.`);
    return;
  }
  lintConstant(where, param, arg.value, input);
}

function lintConstant(where: string, param: ParamInfo, value: ApiArg['value'], input: Readonly<Record<string, unknown>>): void {
  if (!matchesLeaf(param.type, value)) throw invalidHandler(`${where}: the constant must be a ${param.type}.`);
  if (param.values && !param.values.includes(String(value))) throw invalidHandler(`${where}: the constant must be one of ${param.values.join(', ')}.`);
  // The model never sees input values, so a constant equal to one was copied from the intent.
  for (const [name, inputValue] of Object.entries(input)) {
    if (typeof inputValue === 'string' && inputValue.length >= MIN_HARDCODED_LENGTH && inputValue === value) {
      throw invalidHandler(`${where}: the value of input "${name}" is hardcoded; bind it with input: "${name}".`);
    }
  }
}

function invalidHandler(message: string): SlimeError {
  return new SlimeError('INVALID_HANDLER', message);
}
