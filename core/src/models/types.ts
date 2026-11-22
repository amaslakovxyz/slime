// The model ports: Generator, Reviewer and Optimizer. Providers live in sibling
// folders (claude/, groq/, offline/).
import type { ParamTypesForModel } from '../request/params.js';
import type { Shape } from '../request/shape.js';
import type { Artifact } from './artifact.js';


export interface GenerationRequest {
  /** The rendered dictionary (§4.4). */
  context: string;
  intent: string;
  params: ParamTypesForModel;
  output: Shape;
  /** Set when retrying after a failed attempt. */
  previous?: { artifact: Artifact; error: string };
}

export interface ModelUsage {
  /** Model time, excluding provider rate-limit waits. */
  ms: number;
  waitMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface GenerationResult extends ModelUsage {
  artifact: Artifact;
}

export interface ModelCallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface Generator {
  /** `model` and `promptHash` are recorded in each handler's provenance (§4.7). */
  readonly model: string;
  readonly promptHash: string;
  generate(request: GenerationRequest, options: ModelCallOptions): Promise<GenerationResult>;
}

export interface ReviewRequest {
  context: string;
  intent: string;
  params: ParamTypesForModel;
  output: Shape;
  artifact: Artifact;
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
