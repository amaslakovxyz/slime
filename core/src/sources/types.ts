// The ApiSource port: a read-only data provider reached over an API (MS2).
// Implementations: defineApiSource (sources/api/) and notion (sources/notion/).
import type { ColumnInfo, Connector, RunResult, SafetyReport } from '../connectors/types.js';
import type { LeafType } from '../request/shape.js';

export interface SourceCallOptions {
  timeoutMs: number;
  signal: AbortSignal;
}

export interface CallOptions extends SourceCallOptions {
  rowCap: number;
}

export interface ParamInfo {
  name: string;
  type: LeafType;
  comment?: string;
  /** Allowed values, like a Postgres enum (D1). */
  values?: string[];
}

export interface OperationInfo {
  /** For example "feedback.query" or "films.list". */
  name: string;
  description?: string;
  /** Every param is nullable: null means "not given" (R5). */
  params: ParamInfo[];
  /** The flat row each call returns; `type` is an output-notation leaf. */
  columns: ColumnInfo[];
  primaryKey?: string[];
  /** The order rows come back in, for example "created desc". */
  order?: string;
}

export interface ApiSchema {
  /** Shown to the model like a database dialect, for example "Notion API 2025-09-03". */
  service: string;
  operations: OperationInfo[];
}

export interface ApiSource {
  readonly kind: 'api';
  readonly name: string;
  /** Values core redacts from every message and event (MS16). */
  readonly secrets: readonly string[];
  /** Metadata only, never rows (D1). */
  describe(options: SourceCallOptions): Promise<ApiSchema>;
  call(operation: string, args: Readonly<Record<string, unknown>>, options: CallOptions): Promise<RunResult>;
  safetyCheck(options: SourceCallOptions): Promise<SafetyReport>;
  close(): Promise<void>;
}

export type Source = Connector | ApiSource;

export function isApiSource(source: Source): source is ApiSource {
  return source.kind === 'api';
}
