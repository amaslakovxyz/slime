// Parses what a caller passes to slime.query() into a SlimeRequest, or throws
// INVALID_REQUEST with a message the caller can act on (PLAN.md §4.1).
import { SlimeError } from '../errors.js';
import { assertValidShape, type Shape } from './shape.js';

export type InputScalar = string | number | boolean | null;
export type InputValue = InputScalar | InputScalar[];

/** A request, as `slime.query()` accepts it. */
export interface SlimeRequest {
  /** What is wanted, in words. Values belong in `input`. */
  intent: string;
  /** Parameter values. Their names (never their values) are part of the cache key. */
  input?: Record<string, InputValue>;
  /** The shape of `data` in the response (§4.2). */
  output: Shape;
}

/** A request after parsing: `input` is always present. */
export interface ParsedRequest {
  intent: string;
  input: Record<string, InputValue>;
  output: Shape;
}

const FIELDS = ['intent', 'input', 'output'];
const MAX_INTENT = 500;
const MAX_INPUT_KEYS = 20;
const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Reserved input names for paging (R6): non-negative integers, or null for "not given". */
export const PAGING_PARAMS = ['limit', 'offset'] as const;

export function parseRequest(raw: unknown): ParsedRequest {
  if (!isPlainObject(raw)) throw invalid('The request must be an object: { intent, input?, output }.');

  const unknown = Object.keys(raw).filter((k) => !FIELDS.includes(k));
  if (unknown.length) {
    throw invalid(`Unknown request field${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}. Allowed: intent, input, output.`);
  }

  const { intent, input = {}, output } = raw;
  if (typeof intent !== 'string' || !intent.trim()) throw invalid('"intent" must be a non-empty string.');
  if (intent.length > MAX_INTENT) throw invalid(`"intent" must be at most ${MAX_INTENT} characters.`);

  if (!isPlainObject(input)) throw invalid('"input" must be an object of parameter values.');
  const entries = Object.entries(input);
  if (entries.length > MAX_INPUT_KEYS) throw invalid(`"input" may have at most ${MAX_INPUT_KEYS} keys.`);
  for (const [name, value] of entries) {
    if (!INPUT_NAME.test(name)) {
      throw invalid(`Input name "${name}" is not valid: use letters, digits and _, starting with a letter or _ (at most 64 characters).`);
    }
    if (!(isScalar(value) || (Array.isArray(value) && value.every(isScalar)))) {
      throw invalid(`Input "${name}" must be a string, number, boolean, null, or a list of those.`);
    }
  }
  for (const name of PAGING_PARAMS) {
    const value = input[name];
    if (value !== undefined && value !== null && !(Number.isSafeInteger(value) && (value as number) >= 0)) {
      throw invalid(`Input "${name}" is reserved for paging: it must be a non-negative integer or null.`);
    }
  }

  if (output === undefined) throw invalid('"output" (the JSON shape you want back) is required.');
  assertValidShape(output);

  return { intent, input: input as Record<string, InputValue>, output };
}

/**
 * Literal values written into the intent ("orders for customer 4242"). They
 * split the cache by value, and the handler can't be reused for other values.
 * The engine adds a warning to meta.warnings for each (R7). A warning, not an
 * error: "top 10 accounts" and possessives ("the plan's accounts") match too.
 */
export function literalsInIntent(intent: string): string[] {
  const found: string[] = [];
  if (/["'][^"']+["']/.test(intent)) found.push('quoted text');
  if (/\b\d{2,}\b/.test(intent)) found.push('a number');
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(intent)) found.push('an email address');
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-/i.test(intent)) found.push('a UUID');
  return found;
}

function isScalar(value: unknown): value is InputScalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function invalid(message: string): SlimeError {
  return new SlimeError('INVALID_REQUEST', message);
}
