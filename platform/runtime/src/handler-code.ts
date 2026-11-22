// The code behind a handler, for the Requests log's trace drawer (request trace design T6).
// Hits load it here; generations already carry it in their feed event.
import type { CrystalHandler } from '@slime-cloud/core';

export interface HandlerCode {
  key: string;
  tier: 'gas' | 'liquid' | 'crystal';
  sql: string;
  shapeJs?: string;
  assumptions: string[];
}

interface StoredStep {
  sql?: unknown;
  [key: string]: unknown;
}

interface StoredArtifact {
  steps?: StoredStep[];
  sql?: unknown;
  shapeJs?: unknown;
  assumptions?: unknown;
}

const joinSql = (steps: StoredStep[]) => steps.flatMap((s) => (typeof s.sql === 'string' ? [s.sql] : [])).join(';\n\n');

export function codeOfRecord(record: { key: string; tier: 'gas' | 'liquid'; artifact: StoredArtifact }): HandlerCode {
  const { artifact } = record;
  const sql = Array.isArray(artifact.steps) ? joinSql(artifact.steps) : typeof artifact.sql === 'string' ? artifact.sql : '';
  return {
    key: record.key,
    tier: record.tier,
    sql,
    ...(typeof artifact.shapeJs === 'string' && artifact.shapeJs ? { shapeJs: artifact.shapeJs } : {}),
    assumptions: Array.isArray(artifact.assumptions) ? artifact.assumptions.filter((a): a is string => typeof a === 'string') : [],
  };
}

export function codeOfCrystal(key: string, crystal: CrystalHandler): HandlerCode {
  const c = crystal as { sql?: unknown; steps?: { sql?: unknown }[]; shape?: unknown };
  const sql = Array.isArray(c.steps) ? joinSql(c.steps) : typeof c.sql === 'string' ? c.sql : '';
  return { key, tier: 'crystal', sql, ...(typeof c.shape === 'string' ? { shapeJs: c.shape } : {}), assumptions: [] };
}
