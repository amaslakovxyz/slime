// The v2 artifact: a handler made of steps across sources (MS3, MS4;
// docs/request-format.md "Multi-source handlers").
import type { Artifact } from './types.js';

export const ARTIFACT_V2 = 2;

export interface SqlStep {
  name: string;
  /** The SQL source's name. */
  source: string;
  sql: string;
  /** params[0] is the input name bound to $1. */
  params: string[];
}

/** Exactly one of `input` and `value` is non-null; lint enforces it (MS4). */
export interface ApiArg {
  param: string;
  input: string | null;
  value: string | number | boolean | null;
}

export interface ApiStep {
  name: string;
  source: string;
  operation: string;
  args: ApiArg[];
}

export type Step = SqlStep | ApiStep;

export interface ArtifactV2 {
  version: typeof ARTIFACT_V2;
  /** null, or one sentence on why the sources can't answer the request. */
  unsatisfiable: string | null;
  steps: Step[];
  /** Source of `function shape(data, input)`; null only with a single step whose rows are the output. */
  shapeJs: string | null;
  assumptions: string[];
}

export type AnyArtifact = Artifact | ArtifactV2;

export function isArtifactV2(artifact: AnyArtifact): artifact is ArtifactV2 {
  return 'version' in artifact && artifact.version === ARTIFACT_V2;
}

export function isApiStep(step: Step): step is ApiStep {
  return 'operation' in step;
}
