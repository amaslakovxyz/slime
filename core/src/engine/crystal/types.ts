// A Crystal handler as the generated index exports it (C10), or as a host loads it from storage.
import type { ReviewStatus } from '../types.js';
import type { InputValues } from '../../request/parse.js';
import type { ParamTypes } from '../../request/params.js';
import type { Shape } from '../../request/shape.js';

export type ShapeFunction = (rows: Record<string, unknown>[], input: InputValues) => unknown;

export interface CrystalHandler {
  sql: string;
  params: readonly string[];
  /**
   * A function runs in the app's process, with no sandbox: the allowlist checked it when it
   * was written (apps that import `index.mjs`). A string is the source of
   * `function shape(rows, input)` and runs in the engine's sandbox with Liquid's limits
   * (hosts that load Crystal modules as data, such as Slime Cloud).
   */
  shape: ShapeFunction | string | null;
  intent: string;
  output: Shape;
  paramTypes: ParamTypes;
  schemaHash: string;
  review: ReviewStatus;
}

/** Keyed by request key, like saved handlers (§4.7). */
export type CrystalRegistry = Readonly<Record<string, CrystalHandler>>;
