// The SQL source port (a Connector): one database the model writes SQL for.
// Implementations live in sibling folders (postgres/).
import type { ColumnInfo, RunResult, SafetyReport } from '../types.js';

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
  /**
   * In the database's own planner units; the engine compares it with
   * limits.maxQueryCost. null when the database has no cost estimate, which
   * skips that check.
   */
  cost: number | null;
  ms: number;
}

export interface Connector {
  readonly kind: 'sql';
  readonly name: string;
  /** Only what these credentials can read; nothing else is shown to the model. */
  describe(): Promise<SchemaInfo>;
  check(sql: string, params: unknown[], limits: QueryLimits): Promise<QueryPlan>;
  run(sql: string, params: unknown[], limits: QueryLimits): Promise<RunResult>;
  /** Slime refuses to start unless ok: the credentials must not be able to write. */
  safetyCheck(): Promise<SafetyReport>;
  close(): Promise<void>;
}
