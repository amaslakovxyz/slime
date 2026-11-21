// The `output` notation (§4.2; the rules are in request/README.md).
import { SlimeError } from '../shared/errors.js';

export type Shape = string | readonly Shape[] | ObjectShape;

export interface ObjectShape {
  readonly [key: string]: Shape;
}

interface ShapeCheck<S extends Shape = Shape> {
  shape: S;
  value: unknown;
  path: string;
  /** Leave values and data-derived key names out of messages (MS15). */
  isValueFree: boolean;
}

export interface ValidateOptions {
  /** For multi-source handlers, whose repair messages must not carry row data (MS15). */
  isValueFree?: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// A zone is required, so a value never depends on the server's zone.
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export const LEAF_TYPES = Object.freeze(['string', 'number', 'integer', 'boolean', 'date', 'datetime'] as const);
export type LeafType = (typeof LEAF_TYPES)[number];

const LEAF_CHECKS: Readonly<Record<LeafType, (value: unknown) => boolean>> = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => typeof value === 'number' && Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  date: (value) => typeof value === 'string' && DATE.test(value) && isRealDate(value),
  datetime: (value) => typeof value === 'string' && DATETIME.test(value) && !Number.isNaN(Date.parse(value)),
};

const NULLABLE_SUFFIX = '|null';
const LEAF = new RegExp(`^(${LEAF_TYPES.join('|')})(\\|null)?$`);
// Objects and lists both count: { plans: [ { accounts: [ { name } ] } ] } is depth 5.
const MAX_DEPTH = 6;
const MAX_LEAVES = 50;
const MAX_MISMATCHES = 10;
const MAX_PREVIEW_LENGTH = 40;
const ELLIPSIS = '...';
const ROOT_PATH = '$';

export function assertValidShape(shape: unknown): asserts shape is Shape {
  let leafCount = 0;
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw invalid(`${path}: nested deeper than ${MAX_DEPTH}`);
    if (typeof node === 'string') {
      if (!LEAF.test(node)) throw invalid(`${path}: "${node}" is not a type (${LEAF_TYPES.join(', ')}, optionally "|null")`);
      if (++leafCount > MAX_LEAVES) throw invalid(`more than ${MAX_LEAVES} fields`);
      return;
    }
    if (Array.isArray(node)) {
      if (node.length !== 1) throw invalid(`${path}: a list is written as an array with exactly one element`);
      return visit(node[0], `${path}[]`, depth + 1);
    }
    if (isObjectValue(node)) {
      const keys = Object.keys(node);
      if (keys.length === 0) throw invalid(`${path}: empty object`);
      for (const key of keys) visit(node[key], `${path}.${key}`, depth + 1);
      return;
    }
    throw invalid(`${path}: expected a type name, a one-element array, or an object`);
  };
  visit(shape, ROOT_PATH, 0);
}

/** A top-level object means one row, so null (no row) matches it. */
export function validateData(shape: Shape, data: unknown, options: ValidateOptions = {}): string[] {
  if (data === null && isObjectShape(shape)) return [];
  return validateAgainstShape(shape, data, options);
}

export function validateAgainstShape(shape: Shape, value: unknown, { isValueFree = false }: ValidateOptions = {}): string[] {
  const mismatches: string[] = [];
  collectMismatches({ shape, value, path: ROOT_PATH, isValueFree }, mismatches);
  return mismatches;
}

function collectMismatches(check: ShapeCheck, mismatches: string[]): void {
  if (mismatches.length >= MAX_MISMATCHES) return;
  const { shape } = check;
  if (typeof shape === 'string') {
    const mismatch = leafMismatch({ ...check, shape });
    if (mismatch) mismatches.push(mismatch);
  } else if (isListShape(shape)) {
    collectListMismatches({ ...check, shape }, mismatches);
  } else {
    collectObjectMismatches({ ...check, shape }, mismatches);
  }
}

export function isLeafType(name: string): name is LeafType {
  return (LEAF_TYPES as readonly string[]).includes(name);
}

/** Whether a value matches a leaf type such as "integer" or "date|null". */
export function matchesLeaf(type: string, value: unknown): boolean {
  const isNullable = type.endsWith(NULLABLE_SUFFIX);
  if (value === null) return isNullable;
  const typeName = isNullable ? type.slice(0, -NULLABLE_SUFFIX.length) : type;
  return isLeafType(typeName) && LEAF_CHECKS[typeName](value);
}

function leafMismatch({ shape, value, path, isValueFree }: ShapeCheck<string>): string | undefined {
  const isNullable = shape.endsWith(NULLABLE_SUFFIX);
  if (value === null) return isNullable ? undefined : `${path}: null but "${shape}" is not nullable`;
  const typeName = isNullable ? shape.slice(0, -NULLABLE_SUFFIX.length) : shape;
  const matches = isLeafType(typeName) && LEAF_CHECKS[typeName](value);
  return matches ? undefined : `${path}: expected ${shape}, got ${describeValue(value, isValueFree)}`;
}

function collectListMismatches({ shape, value, path, isValueFree }: ShapeCheck<readonly Shape[]>, mismatches: string[]): void {
  if (!Array.isArray(value)) {
    mismatches.push(`${path}: expected a list, got ${describeValue(value, isValueFree)}`);
    return;
  }
  const itemShape = shape[0]!;
  value.forEach((item, index) => collectMismatches({ shape: itemShape, value: item, path: `${path}[${index}]`, isValueFree }, mismatches));
}

function collectObjectMismatches({ shape, value, path, isValueFree }: ShapeCheck<ObjectShape>, mismatches: string[]): void {
  if (!isObjectValue(value)) {
    mismatches.push(`${path}: expected an object, got ${describeValue(value, isValueFree)}`);
    return;
  }
  for (const key of Object.keys(shape)) {
    const fieldPath = `${path}.${key}`;
    if (key in value) collectMismatches({ shape: shape[key]!, value: value[key], path: fieldPath, isValueFree }, mismatches);
    else mismatches.push(`${fieldPath}: missing`);
  }
  const unrequested = Object.keys(value).filter((key) => !(key in shape));
  // Returned key names can come from data (for example grouping by account name).
  if (isValueFree && unrequested.length > 0) mismatches.push(`${path}: ${unrequested.length} key(s) not requested`);
  else for (const key of unrequested) mismatches.push(`${path}.${key}: not requested`);
}

/** Rejects strings like 2026-02-30 that match the pattern but name no day. */
function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function isListShape(shape: Shape): shape is readonly Shape[] {
  return Array.isArray(shape);
}

function isObjectShape(shape: Shape): shape is ObjectShape {
  return typeof shape === 'object' && !Array.isArray(shape);
}

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function describeValue(value: unknown, isValueFree = false): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'number' && !Number.isInteger(value)) return 'a decimal number';
  if (typeof value === 'string') return isValueFree ? 'a string' : `the string ${JSON.stringify(preview(value))}`;
  return typeof value;
}

function preview(text: string): string {
  if (text.length <= MAX_PREVIEW_LENGTH) return text;
  return `${text.slice(0, MAX_PREVIEW_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`;
}

function invalid(message: string): SlimeError {
  return new SlimeError('INVALID_REQUEST', `Invalid output shape: ${message}`);
}
