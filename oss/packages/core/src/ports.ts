// The contracts (Ports) core depends on. Implementations are passed in through
// SlimeConfig; core never imports a database driver or model SDK from its main
// entry (PLAN.md C7, C14).
import type { ParamType } from './request/params.js';
import type { Shape } from './request/shape.js';

// ---------------------------------------------------------------------------
// Connector: where the app's data comes from.

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  comment?: string;
  /** Allowed values of an enum-like column, read from the catalog (enum types, CHECK … IN), never from rows (D1). */
  values?: string[];
}

export interface TableInfo {
  name: string;
  comment?: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  /** `references` is "table.column". */
  foreignKeys: { column: string; references: string }[];
}

export interface SchemaInfo {
  /** For example "postgresql 16"; shown to the model so it writes the right dialect. */
  dialect: string;
  tables: TableInfo[];
}

export interface RunResult {
  rows: Record<string, unknown>[];
  /** More rows existed than the row cap allowed. */
  truncated: boolean;
  ms: number;
}

export interface SafetyReport {
  ok: boolean;
  user: string;
  problems: string[];
}

/**
 * Limits for one call, passed by the engine from SlimeConfig.limits. The app
 * builds the connector before SlimeConfig exists, so limits travel with each
 * call instead of being connector options (§5).
 */
export interface QueryLimits {
  timeoutMs: number;
  /** Return at most this many rows and set `truncated` when there were more. */
  rowCap: number;
}

export interface Connector {
  readonly name: string;
  /** Tables and columns these credentials can read. Nothing else is shown to the model. */
  describe(): Promise<SchemaInfo>;
  /**
   * Cheap pre-flight: does the query parse and plan, and how expensive is it?
   * The engine compares `cost` with limits.maxQueryCost and raises
   * QUERY_TOO_EXPENSIVE itself; the connector only reports.
   */
  check(sql: string, params: unknown[], limits: QueryLimits): Promise<{ cost: number; ms: number }>;
  /** Runs one read-only query within the timeout and row cap. */
  run(sql: string, params: unknown[], limits: QueryLimits): Promise<RunResult>;
  /** Reports whether the credentials could write or are too powerful; Slime refuses to start if not ok. */
  safetyCheck(): Promise<SafetyReport>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Generator and Reviewer: the models.

/** The code a model writes for one request. */
export interface Artifact {
  /** null, or one sentence on why the schema can't answer the request. */
  unsatisfiable: string | null;
  /** One read-only SELECT with $1, $2, ... placeholders. */
  sql: string;
  /** The input name bound to each placeholder: params[0] is $1. */
  params: string[];
  /** Source of `function shape(rows, input)`, or null when rows already match the output. */
  shapeJs: string | null;
  /** The model's interpretations, shown to the developer in meta. */
  assumptions: string[];
}

export interface GenerationRequest {
  /** Everything the model knows about the database: the rendered dictionary (§4.4). */
  context: string;
  intent: string;
  /** Input names with their coarse types; 'unknown' while only null was seen. Never values. */
  params: Record<string, ParamType | 'unknown'>;
  output: Shape;
  /** Set when retrying after a failed attempt. */
  previous?: { artifact: Artifact; error: string };
}

export interface GenerationResult {
  artifact: Artifact;
  /** Model time, excluding provider rate-limit waits. */
  ms: number;
  waitMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Generator {
  /** Recorded in each handler's provenance; in explore mode a different model regenerates it. */
  readonly model: string;
  /** Hash of this generator's prompt text, recorded like `model`; editing the prompt regenerates handlers in explore mode. */
  readonly promptHash: string;
  generate(req: GenerationRequest, options: { timeoutMs: number; signal?: AbortSignal }): Promise<GenerationResult>;
}

export interface ReviewRequest {
  context: string;
  intent: string;
  params: Record<string, ParamType | 'unknown'>;
  output: Shape;
  artifact: Artifact;
}

export interface ReviewResult {
  verdict: 'approve' | 'reject';
  problems: string[];
  ms: number;
  waitMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Reviewer {
  readonly model: string;
  review(req: ReviewRequest, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ReviewResult>;
}

// ---------------------------------------------------------------------------
// SandboxRunner: where generated shaping code runs (C3: runtime-specific).
// Exported as a type only: in v1 core always uses its own QuickJS runner, and
// there is no option to pass another (§5).

export interface SandboxLimits {
  timeoutMs: number;
  memoryBytes: number;
}

export interface SandboxRunner {
  /** Runs `function shape(rows, input)` from `code` with no I/O, and returns its result. */
  run(code: string, rows: unknown[], input: Record<string, unknown>, limits: SandboxLimits): Promise<unknown>;
  close(): Promise<void>;
}
