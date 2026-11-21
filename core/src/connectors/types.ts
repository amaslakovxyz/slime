// The Connector port: where the app's data comes from. Implementations live
// in sibling folders (postgres/).
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
  /**
   * In the database's own planner units; the engine compares it with
   * limits.maxQueryCost. null when the database has no cost estimate, which
   * skips that check.
   */
  cost: number | null;
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
