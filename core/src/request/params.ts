// R4, R5: a handler records each parameter's type from its first non-null value
// and refuses other types later. null means "not given" and fits every type, so
// one handler serves every combination of optional filters.
import { SlimeError } from '../shared/errors.js';
import type { InputValue, InputValues } from './parse.js';

export type ParamType = 'string' | 'number' | 'boolean' | 'list';

/** null while only null has been seen. */
export type ParamTypes = Record<string, ParamType | null>;

/** What a model sees: 'unknown' while only null has been seen. Never values. */
export type ParamTypesForModel = Record<string, ParamType | 'unknown'>;

export function paramTypesForModel(paramTypes: Readonly<ParamTypes>): ParamTypesForModel {
  return Object.fromEntries(Object.entries(paramTypes).map(([name, type]) => [name, type ?? 'unknown']));
}

export function coarseType(value: InputValue): ParamType | null {
  if (value === null) return null;
  if (Array.isArray(value)) return 'list';
  return typeof value as 'string' | 'number' | 'boolean';
}

/** Returns the record with types learned from this input; throws INVALID_REQUEST on any mismatch. */
export function checkParamTypes(recorded: Readonly<ParamTypes>, input: Readonly<InputValues>): ParamTypes {
  const updated: ParamTypes = { ...recorded };
  const mismatches: string[] = [];
  for (const [name, value] of Object.entries(input)) {
    const actual = coarseType(value);
    const expected = recorded[name];
    if (actual === null) updated[name] ??= null;
    else if (!expected) updated[name] = actual;
    else if (expected !== actual) mismatches.push(`"${name}" must be ${withArticle(expected)}, got ${withArticle(actual)}`);
  }
  if (mismatches.length > 0) {
    throw new SlimeError('INVALID_REQUEST', `Input type mismatch: ${mismatches.join('; ')}.`, { details: { mismatches } });
  }
  return updated;
}

function withArticle(type: ParamType): string {
  return type === 'list' ? 'a list' : `a ${type}`;
}
