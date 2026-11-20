// Parameter types, recorded per handler instead of being part of the key
// (PLAN.md R4, R5). A handler behaves like a typed route: the first non-null
// value of each parameter fixes its coarse type, and a later value of another
// type is refused. Whole and decimal numbers are the same type. null means
// "not given" and fits every type, so one handler serves every combination of
// optional filters.
import { SlimeError } from '../errors.js';
import type { InputValue } from './parse.js';

export type ParamType = 'string' | 'number' | 'boolean' | 'list';

/** Known type per parameter; null while only null has been seen. */
export type ParamTypes = Record<string, ParamType | null>;

/** The coarse type of a value, or null for null. */
export function coarseType(value: InputValue): ParamType | null {
  if (value === null) return null;
  if (Array.isArray(value)) return 'list';
  return typeof value as 'string' | 'number' | 'boolean';
}

/**
 * Checks `input` against the types a handler has recorded and returns the
 * updated record (types learned from values that were null before). Throws
 * INVALID_REQUEST when a value has a different type than recorded.
 */
export function checkParamTypes(known: Readonly<ParamTypes>, input: Readonly<Record<string, InputValue>>): ParamTypes {
  const next: ParamTypes = { ...known };
  const mismatches: string[] = [];
  for (const [name, value] of Object.entries(input)) {
    const type = coarseType(value);
    const expected = known[name];
    if (type === null) {
      if (!(name in next)) next[name] = null;
    } else if (expected === undefined || expected === null) {
      next[name] = type;
    } else if (expected !== type) {
      mismatches.push(`"${name}" must be ${article(expected)}, got ${article(type)}`);
    }
  }
  if (mismatches.length) {
    throw new SlimeError('INVALID_REQUEST', `Input type mismatch: ${mismatches.join('; ')}.`, false, { mismatches });
  }
  return next;
}

function article(type: ParamType): string {
  return type === 'list' ? 'a list' : `a ${type}`;
}
