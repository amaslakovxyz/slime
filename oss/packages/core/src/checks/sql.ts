// Static checks on generated code before it touches the database. Defence in
// depth only: the read-only database user is the real boundary.
import { SlimeError } from '../errors.js';
import type { Artifact } from '../ports.js';

const WRITE_SQL =
  /\b(insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|vacuum|set_config|pg_sleep|pg_read_file|lo_import|dblink)\b/i;

export function assertReadOnlySql(sql: string): void {
  if (WRITE_SQL.test(sql)) {
    throw new SlimeError('WRITE_REFUSED', 'SQL contains a write or a forbidden function; refused.', false, { enforcedBy: 'lint' });
  }
}

/**
 * Checks that the SQL reads only, that every $n maps to an input name and is
 * used, and that no input value was copied into the code.
 */
export function lintArtifact(artifact: Artifact, input: Readonly<Record<string, unknown>>): void {
  assertReadOnlySql(artifact.sql);
  const used = new Set([...artifact.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  const highest = Math.max(0, ...used);
  if (highest > artifact.params.length) {
    throw new SlimeError('INVALID_HANDLER', `SQL uses $${highest} but only ${artifact.params.length} params are mapped.`);
  }
  artifact.params.forEach((name, i) => {
    if (!(name in input)) throw new SlimeError('INVALID_HANDLER', `Param $${i + 1} maps to "${name}", which is not an input name.`);
    if (!used.has(i + 1)) throw new SlimeError('INVALID_HANDLER', `Param $${i + 1} ("${name}") is mapped but never used in the SQL.`);
  });
  // The model never sees input values, so a value appearing in the code means it
  // was copied from the intent: the handler would return wrong data for other values.
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > 2) {
      if (artifact.sql.includes(value) || artifact.shapeJs?.includes(value)) {
        throw new SlimeError('INVALID_HANDLER', `The value of input "${name}" is hardcoded in the handler; use $n / input.${name}.`);
      }
    }
  }
}
