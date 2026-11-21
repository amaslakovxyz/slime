// Every failure is INVALID_REQUEST with a message the caller can act on (§4.1).
import { SlimeError } from '../errors.js';
import { isPlainObject } from '../guards.js';
import { assertValidShape, type Shape } from './shape.js';

export type InputScalar = string | number | boolean | null;
export type InputValue = InputScalar | InputScalar[];
export type InputValues = Record<string, InputValue>;

export interface SlimeRequest {
  /** What is wanted, in words. Values belong in `input`. */
  intent: string;
  /** Names are part of the cache key; values never are. */
  input?: InputValues;
  output: Shape;
}

export interface ParsedRequest {
  intent: string;
  input: InputValues;
  output: Shape;
}

interface LiteralPattern {
  label: string;
  pattern: RegExp;
}

const REQUEST_FIELDS = ['intent', 'input', 'output'];
const MAX_INTENT_LENGTH = 500;
const MAX_INPUT_NAMES = 20;
const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** R6: non-negative integers, or null for "not given". */
export const PAGING_PARAMS = ['limit', 'offset'] as const;

const LITERAL_PATTERNS: readonly LiteralPattern[] = [
  { label: 'quoted text', pattern: /["'][^"']+["']/ },
  { label: 'a number', pattern: /\b\d{2,}\b/ },
  { label: 'an email address', pattern: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { label: 'a UUID', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-/i },
];

export function parseRequest(raw: unknown): ParsedRequest {
  if (!isPlainObject(raw)) throw invalid('The request must be an object: { intent, input?, output }.');
  assertKnownFields(raw);

  const { intent, input = {}, output } = raw;
  assertValidIntent(intent);
  assertValidInput(input);
  assertValidPaging(input);
  if (output === undefined) throw invalid('"output" (the JSON shape you want back) is required.');
  assertValidShape(output);

  return { intent, input, output };
}

/** R7: the engine turns each into a warning, never an error: "top 10" and possessives match too. */
export function literalsInIntent(intent: string): string[] {
  return LITERAL_PATTERNS.filter(({ pattern }) => pattern.test(intent)).map(({ label }) => label);
}

function assertKnownFields(request: Record<string, unknown>): void {
  const unknownFields = Object.keys(request).filter((field) => !REQUEST_FIELDS.includes(field));
  if (unknownFields.length === 0) return;
  const plural = unknownFields.length > 1 ? 's' : '';
  const quoted = unknownFields.map((field) => `"${field}"`).join(', ');
  throw invalid(`Unknown request field${plural} ${quoted}. Allowed: intent, input, output.`);
}

function assertValidIntent(intent: unknown): asserts intent is string {
  if (typeof intent !== 'string' || !intent.trim()) throw invalid('"intent" must be a non-empty string.');
  if (intent.length > MAX_INTENT_LENGTH) throw invalid(`"intent" must be at most ${MAX_INTENT_LENGTH} characters.`);
}

function assertValidInput(input: unknown): asserts input is InputValues {
  if (!isPlainObject(input)) throw invalid('"input" must be an object of parameter values.');
  const entries = Object.entries(input);
  if (entries.length > MAX_INPUT_NAMES) throw invalid(`"input" may have at most ${MAX_INPUT_NAMES} keys.`);
  for (const [name, value] of entries) {
    if (!INPUT_NAME.test(name)) {
      throw invalid(`Input name "${name}" is not valid: use letters, digits and _, starting with a letter or _ (at most 64 characters).`);
    }
    if (!isInputValue(value)) throw invalid(`Input "${name}" must be a string, number, boolean, null, or a list of those.`);
  }
}

function assertValidPaging(input: InputValues): void {
  for (const name of PAGING_PARAMS) {
    const value = input[name];
    if (value === undefined || value === null || isNonNegativeInteger(value)) continue;
    throw invalid(`Input "${name}" is reserved for paging: it must be a non-negative integer or null.`);
  }
}

function isInputValue(value: unknown): value is InputValue {
  return isInputScalar(value) || (Array.isArray(value) && value.every(isInputScalar));
}

function isInputScalar(value: unknown): value is InputScalar {
  if (typeof value === 'number') return Number.isFinite(value);
  return value === null || typeof value === 'string' || typeof value === 'boolean';
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function invalid(message: string): SlimeError {
  return new SlimeError('INVALID_REQUEST', message);
}
