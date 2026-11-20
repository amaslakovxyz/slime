// The `output` notation callers use to describe the JSON they want back:
//   leaves are type names: "string" | "number" | "integer" | "boolean", optionally "|null"
//   an array with exactly one element means "a list of these"
//   an object means an object with exactly these keys
// Example: { "plans": [ { "plan": "string", "accounts": [ { "name": "string", "mrr": "number|null" } ] } ] }
import { SlimeError } from './errors.js';

export type Shape = string | Shape[] | { [key: string]: Shape };

const LEAF = /^(string|number|integer|boolean)(\|null)?$/;
// Depth counts both objects and lists: { plans: [ { accounts: [ { name } ] } ] } is depth 5.
const LIMITS = { maxDepth: 6, maxLeaves: 50 };

/** Rejects malformed shapes before anything is generated. */
export function assertValidShape(shape: unknown): asserts shape is Shape {
  let leaves = 0;
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > LIMITS.maxDepth) throw invalid(`${path}: nested deeper than ${LIMITS.maxDepth}`);
    if (typeof node === 'string') {
      if (!LEAF.test(node)) throw invalid(`${path}: "${node}" is not a type (string, number, integer, boolean, optionally "|null")`);
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

/** Returns a list of mismatches (empty when `value` matches `shape`). */
export function validateAgainstShape(shape: Shape, value: unknown, path = '$', out: string[] = []): string[] {
  if (out.length >= 10) return out;
  if (typeof shape === 'string') {
    const [type, nullable] = [shape.replace('|null', ''), shape.endsWith('|null')];
    if (value === null) {
      if (!nullable) out.push(`${path}: null but "${shape}" is not nullable`);
      return out;
    }
    const ok =
      (type === 'string' && typeof value === 'string') ||
      (type === 'boolean' && typeof value === 'boolean') ||
      (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (type === 'integer' && typeof value === 'number' && Number.isInteger(value));
    if (!ok) out.push(`${path}: expected ${shape}, got ${describe(value)}`);
    return out;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) {
      out.push(`${path}: expected a list, got ${describe(value)}`);
      return out;
    }
    value.forEach((item, i) => validateAgainstShape(shape[0], item, `${path}[${i}]`, out));
    return out;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    out.push(`${path}: expected an object, got ${describe(value)}`);
    return out;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(shape)) {
    if (!(key in obj)) out.push(`${path}.${key}: missing`);
    else validateAgainstShape(shape[key], obj[key], `${path}.${key}`, out);
  }
  for (const key of Object.keys(obj)) {
    if (!(key in shape)) out.push(`${path}.${key}: not requested`);
  }
  return out;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value === 'number' && !Number.isInteger(value) ? 'a decimal number' : typeof value;
}

function invalid(message: string) {
  return new SlimeError('INVALID_REQUEST', `Invalid output shape: ${message}`);
}
