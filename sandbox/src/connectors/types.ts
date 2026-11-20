// The contract every data source implements. Generated code never sees a
// connector: the engine calls it with the generated SQL and the bound params.
// Future connectors (SQLite, DuckDB for Parquet/files, REST-as-tables) implement
// the same three calls; each enforces read-only access in its own way.

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  comment?: string;
}

export interface TableInfo {
  name: string;
  comment?: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: { column: string; references: string }[]; // references = "table.column"
}

export interface SchemaInfo {
  dialect: string; // e.g. "postgresql 16"; shown to the model so it writes the right SQL
  tables: TableInfo[];
}

export interface RunResult {
  rows: Record<string, unknown>[];
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
  /** Tables and columns this connector's credentials can read. Nothing else is shown to the model. */
  describe(): Promise<SchemaInfo>;
  /** Cheap pre-flight: does the query parse, plan, and stay under the cost cap? */
  check(sql: string, params: unknown[]): Promise<{ cost: number; ms: number }>;
  /** Runs one read-only query with a timeout and a row cap. */
  run(sql: string, params: unknown[]): Promise<RunResult>;
  /** Refuses to serve if the credentials could write or are too powerful. */
  safetyCheck(): Promise<SafetyReport>;
  close(): Promise<void>;
}
