// A Crystal handler as the generated index exports it (C10), or as a host loads it from storage.
// Two forms: one SQL query with `shape(rows, input)`, or a handler's steps (SQL and API,
// MS3) with `shape(data, input)`, where `data` holds each step's rows by step name.
import type { Step } from '../artifact/artifact.js';
import type { ReviewStatus } from './record.js';
import type { InputValues } from '../request/parse.js';
import type { ParamTypes } from '../request/params.js';
import type { Shape } from '../request/shape.js';

export type ShapeFunction = (rows: Record<string, unknown>[], input: InputValues) => unknown;
export type StepsShapeFunction = (data: Record<string, Record<string, unknown>[]>, input: InputValues) => unknown;

interface CrystalMetadata {
  intent: string;
  output: Shape;
  paramTypes: ParamTypes;
  schemaHash: string;
  review: ReviewStatus;
}

/**
 * A shape function runs in the app's process, with no sandbox: the allowlist checked it when
 * it was written (apps that import `index.mjs`). A string is its source and runs in the
 * engine's sandbox with Liquid's limits (hosts that load Crystal modules as data, such as
 * Slime Cloud).
 */
export interface QueryCrystal extends CrystalMetadata {
  sql: string;
  params: readonly string[];
  shape: ShapeFunction | string | null;
}

export interface StepsCrystal extends CrystalMetadata {
  /** Run in parallel, as Liquid runs them (design §3.5); API steps need the app's sources. */
  steps: readonly Step[];
  /** null only with a single step whose rows are the output. */
  shape: StepsShapeFunction | string | null;
}

export type CrystalHandler = QueryCrystal | StepsCrystal;

export function isStepsCrystal(crystal: CrystalHandler): crystal is StepsCrystal {
  return 'steps' in crystal;
}

/** Keyed by request key, like saved handlers (§4.7). */
export type CrystalRegistry = Readonly<Record<string, CrystalHandler>>;
