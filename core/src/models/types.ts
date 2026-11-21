// The model ports: Generator, Reviewer and Optimizer. Providers live in sibling
// folders (claude/, groq/, offline/).
import type { ParamType } from '../request/params.js';
import type { Shape } from '../request/shape.js';
import type { AnyArtifact } from './artifact-v2.js';

export interface Artifact {
  /** null, or one sentence on why the schema can't answer the request. */
  unsatisfiable: string | null;
  /** One read-only SELECT with $1, $2, ... placeholders. */
  sql: string;
  /** params[0] is the input name bound to $1. */
  params: string[];
  /** Source of `function shape(rows, input)`; null when rows already match the output. */
  shapeJs: string | null;
  assumptions: string[];
}

export type ArtifactFormat = 'v1' | 'v2';

/** 'unknown' while only null has been seen. Never values. */
export type ParamTypesForModel = Record<string, ParamType | 'unknown'>;

export interface GenerationRequest {
  /** The rendered dictionary (§4.4). */
  context: string;
  intent: string;
  params: ParamTypesForModel;
  output: Shape;
  /** Set when retrying after a failed attempt. */
  previous?: { artifact: AnyArtifact; error: string };
  /** 'v2' when the instance has API sources (MS3); missing means 'v1'. */
  format?: ArtifactFormat;
}

export interface ModelUsage {
  /** Model time, excluding provider rate-limit waits. */
  ms: number;
  waitMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface GenerationResult extends ModelUsage {
  artifact: AnyArtifact;
}

export interface ModelCallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface Generator {
  /** `model` and `promptHash` are recorded in each handler's provenance (§4.7). */
  readonly model: string;
  readonly promptHash: string;
  /** Hash of the multi-source prompts, recorded instead of promptHash when API sources are configured (MS3). Optional so existing custom generators compile. */
  readonly multiSourcePromptHash?: string;
  generate(request: GenerationRequest, options: ModelCallOptions): Promise<GenerationResult>;
}

export interface ReviewRequest {
  context: string;
  intent: string;
  params: ParamTypesForModel;
  output: Shape;
  /** Custom reviewers that read `.sql` must also handle v2 artifacts. */
  artifact: AnyArtifact;
}

export interface ReviewResult extends ModelUsage {
  verdict: 'approve' | 'reject';
  problems: string[];
}

export interface Reviewer {
  readonly model: string;
  review(request: ReviewRequest, options: ModelCallOptions): Promise<ReviewResult>;
}

// ---------------------------------------------------------------------------
// Optimizer: rewrites a proven Liquid handler into Crystal form (M5). It sees
// only code, never the intent (a crafted intent can't instruct it) and never data.

export interface OptimizeRequest {
  sql: string;
  params: string[];
  shapeJs: string | null;
  output: Shape;
  paramTypes: ParamTypesForModel;
}

export interface OptimizedCode {
  sql: string;
  params: string[];
  /** Source of `function shape(rows, input)`, or null when SQL rows are the output. */
  shape: string | null;
  notes: string[];
}

export interface OptimizeResult extends ModelUsage {
  code: OptimizedCode;
}

export interface Optimizer {
  readonly model: string;
  optimize(request: OptimizeRequest, options: ModelCallOptions): Promise<OptimizeResult>;
}
