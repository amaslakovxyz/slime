// The code behind a handler, for the Requests log's trace drawer (request trace design T6).
// Hits load it here; generations already carry it in their feed event. The SQL format must
// match a miss event's (meta.sql, from core's sqlOf): the drawer shows the same handler's
// code whichever event it was reached from.
import type { Artifact, CrystalHandler, HandlerRecord } from '@slime-cloud/core';
import { isStepsCrystal, sqlOf } from '@slime-cloud/core/tooling';

export interface HandlerCode {
  key: string;
  tier: 'gas' | 'liquid' | 'crystal';
  sql: string;
  shapeJs?: string;
  assumptions: string[];
}

export function codeOfRecord(record: Pick<HandlerRecord, 'key' | 'tier' | 'artifact'>): HandlerCode {
  const { artifact } = record;
  return {
    key: record.key,
    tier: record.tier,
    sql: sqlOf(artifact),
    ...(artifact.shapeJs ? { shapeJs: artifact.shapeJs } : {}),
    assumptions: artifact.assumptions,
  };
}

export function codeOfCrystal(key: string, crystal: CrystalHandler): HandlerCode {
  const sql = isStepsCrystal(crystal) ? sqlOf(artifactOfSteps(crystal.steps)) : crystal.sql;
  return { key, tier: 'crystal', sql, ...(typeof crystal.shape === 'string' ? { shapeJs: crystal.shape } : {}), assumptions: [] };
}

/** Same construction as core's own sqlOfCrystal (engine/crystal/answer.ts): sqlOf only reads `steps`. */
function artifactOfSteps(steps: readonly Artifact['steps'][number][]): Artifact {
  return { version: 2, unsatisfiable: null, steps: [...steps], shapeJs: null, assumptions: [] };
}
