// Where data comes from: exactly one SQL source (sql/) and any number of API
// sources (api/) (MS1). The types both kinds share live here.
import type { ApiSource } from './api/types.js';
import type { Connector } from './sql/types.js';

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  comment?: string;
  /** Read from the catalog (enum types, CHECK … IN), never from rows (D1). */
  values?: string[];
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

export type Source = Connector | ApiSource;

export function isApiSource(source: Source): source is ApiSource {
  return source.kind === 'api';
}
