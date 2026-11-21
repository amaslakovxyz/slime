// A Crystal handler as the generated index exports it (C10).
import type { ReviewStatus } from '../types.js';
import type { InputValues } from '../../request/parse.js';
import type { ParamTypes } from '../../request/params.js';
import type { Shape } from '../../request/shape.js';

export type ShapeFunction = (rows: Record<string, unknown>[], input: InputValues) => unknown;

export interface CrystalHandler {
  sql: string;
  params: readonly string[];
  /** Runs in the app's process, with no sandbox: the allowlist checked it when it was written. */
  shape: ShapeFunction | null;
  intent: string;
  output: Shape;
  paramTypes: ParamTypes;
  schemaHash: string;
  review: ReviewStatus;
}

/** Keyed by request key, like saved handlers (§4.7). */
export type CrystalRegistry = Readonly<Record<string, CrystalHandler>>;
