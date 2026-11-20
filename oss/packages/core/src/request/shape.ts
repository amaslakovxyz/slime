// The `output` notation a caller uses to describe the JSON it wants back
// (PLAN.md §4.2):
//   leaves are type names: string | number | integer | boolean | date | datetime,
//     each optionally followed by "|null";
//   an array with exactly one element means "a list of these";
//   an object means an object with exactly these keys.
// At the top level a list means rows, and an object means one row: `data` is
// then null when there is no row (see validateData).
// Example: { "plans": [ { "plan": "string", "accounts": [ { "name": "string", "since": "date" } ] } ] }
import { SlimeError } from '../errors.js';

export type Shape = string | readonly Shape[] | { readonly [key: string]: Shape };

const LEAF = /^(string|number|integer|boolean|date|datetime)(\|null)?$/;
// Depth counts both objects and lists: { plans: [ { accounts: [ { name } ] } ] } is depth 5.
const LIMITS = { maxDepth: 6, maxLeaves: 50 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// ISO 8601 with a time zone (Z or ±hh:mm), so a value never depends on the server's zone.
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Rejects malformed shapes before anything is generated. */
export function assertValidShape(shape: unknown): asserts shape is Shape {
  let leaves = 0;
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > LIMITS.maxDepth) throw invalid(`${path}: nested deeper than ${LIMITS.maxDepth}`);
    if (typeof node === 'string') {
      if (!LEAF.test(node)) {
        throw invalid(`${path}: "${node}" is not a type (string, number, integer, boolean, date, datetime, optionally "|null")`);
      }
      if (++leaves > LIMITS.maxLeaves) throw invalid(`more than ${LIMITS.maxLeaves} fields`);
      return;
    }
    if (Array.isArray(node)) {
      if (node.length !== 1) throw invalid(`${path}: a list is written as an array with exactly one element`);
      return walk(node[0], `${path}[]`, depth + 1);
    }
    if (node && typeof node === 'object') {
      const keys = Object.keys(node);
      if (keys.length === 0) throw invalid(`${path}: empty object`);
      for (const key of keys) walk((node as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
      return;
    }
    throw invalid(`${path}: expected a type name, a one-element array, or an object`);
  };
  walk(shape, '$', 0);
}

/**
 * Checks a handler's result against the requested shape. A top-level object
 * means one row, so `null` (no row) is accepted there. Returns the mismatches;
 * an empty list means the data matches.
 */
export function validateData(shape: Shape, data: unknown): string[] {
  if (data === null && isObjectShape(shape)) return [];
  return validateAgainstShape(shape, data);
}

/** Returns a list of mismatches (empty when `value` matches `shape`), at most 10. */
export function validateAgainstShape(shape: Shape, value: unknown, path = '$', out: string[] = []): string[] {
  if (out.length >= 10) return out;
  if (typeof shape === 'string') {
    const nullable = shape.endsWith('|null');
    const type = nullable ? shape.slice(0, -'|null'.length) : shape;
    if (value === null) {
      if (!nullable) out.push(`${path}: null but "${shape}" is not nullable`);
      return out;
    }
    if (!leafMatches(type, value)) out.push(`${path}: expected ${shape}, got ${describe(value)}`);
    return out;
  }
  if (isListShape(shape)) {
    if (!Array.isArray(value)) {
      out.push(`${path}: expected a list, got ${describe(value)}`);
      return out;
    }
    value.forEach((item, i) => validateAgainstShape(shape[0]!, item, `${path}[${i}]`, out));
    return out;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    out.push(`${path}: expected an object, got ${describe(value)}`);
    return out;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(shape)) {
    if (!(key in obj)) out.push(`${path}.${key}: missing`);
    else validateAgainstShape(shape[key]!, obj[key], `${path}.${key}`, out);
  }
  for (const key of Object.keys(obj)) {
    if (!(key in shape)) out.push(`${path}.${key}: not requested`);
  }
  return out;
}

function leafMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'date':
      return typeof value === 'string' && DATE.test(value) && isRealDate(value);
    case 'datetime':
      return typeof value === 'string' && DATETIME.test(value) && !Number.isNaN(Date.parse(value));
    default:
      return false;
  }
}

/** Rejects 2026-02-30 and similar strings that match the pattern but name no day. */
function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function isListShape(shape: Shape): shape is readonly Shape[] {
  return Array.isArray(shape);
}

function isObjectShape(shape: Shape): shape is { readonly [key: string]: Shape } {
  return typeof shape === 'object' && !Array.isArray(shape);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'number' && !Number.isInteger(value)) return 'a decimal number';
  if (typeof value === 'string') return `the string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}...` : value)}`;
  return typeof value;
}

function invalid(message: string): SlimeError {
  return new SlimeError('INVALID_REQUEST', `Invalid output shape: ${message}`);
}
