// The contracts core depends on. The app passes implementations through
// SlimeConfig, so the main entry never imports a driver or model SDK (C7).
import type { ParamType } from './request/params.js';
import type { Shape } from './request/shape.js';

// ---------------------------------------------------------------------------
// Connector: where the app's data comes from.

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  comment?: string;
  /** Read from the catalog (enum types, CHECK … IN), never from rows (D1). */
  values?: string[];
}

export interface ForeignKey {
  column: string;
  /** "table.column" */
  references: string;
}

export interface TableInfo {
  name: string;
  comment?: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
}

export interface SchemaInfo {
  /** Shown to the model so it writes the right dialect, for example "postgresql 16". */
  dialect: string;
  tables: TableInfo[];
}

/** The engine passes these with each call: the app builds the connector before SlimeConfig exists. */
export interface QueryLimits {
  timeoutMs: number;
  rowCap: number;
}

export interface QueryPlan {
  /** In database planner units; the engine compares it with limits.maxQueryCost. */
  cost: number;
  ms: number;
}

export interface RunResult {
  rows: Record<string, unknown>[];
  /** More rows existed than rowCap. */
  truncated: boolean;
  ms: number;
}

export interface SafetyReport {
  ok: boolean;
  user: string;
  problems: string[];
}

export interface Connector {
  readonly name: string;
  /** Only what these credentials can read; nothing else is shown to the model. */
  describe(): Promise<SchemaInfo>;
  check(sql: string, params: unknown[], limits: QueryLimits): Promise<QueryPlan>;
  run(sql: string, params: unknown[], limits: QueryLimits): Promise<RunResult>;
  /** Slime refuses to start unless ok: the credentials must not be able to write. */
  safetyCheck(): Promise<SafetyReport>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Generator and Reviewer: the models.

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

/** 'unknown' while only null has been seen. Never values. */
export type ParamTypesForModel = Record<string, ParamType | 'unknown'>;

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
// SandboxRunner: where generated shaping code runs (C3). A type only in v1:
// core always uses its own QuickJS runner (§5).

export interface SandboxLimits {
  timeoutMs: number;
  memoryBytes: number;
}

export interface ShapeJob {
  /** Source of `function shape(rows, input)`; it runs with no I/O. */
  code: string;
  rows: unknown[];
  input: Record<string, unknown>;
}

export interface SandboxRunner {
  run(job: ShapeJob, limits: SandboxLimits): Promise<unknown>;
  close(): Promise<void>;
}
