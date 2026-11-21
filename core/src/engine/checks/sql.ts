// Defence in depth only: the read-only database user is the real boundary.
import { SlimeError } from '../../shared/errors.js';
import type { Artifact } from '../../models/types.js';

type Inputs = Readonly<Record<string, unknown>>;

const WRITE_SQL =
  /\b(insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|vacuum|set_config|pg_sleep|pg_read_file|lo_import|dblink)\b/i;
const PLACEHOLDER = /\$(\d+)/g;
// Two-letter values such as "DE" would match inside keywords like DESC.
const MIN_HARDCODED_LENGTH = 3;

export function assertReadOnlySql(sql: string): void {
  if (!WRITE_SQL.test(sql)) return;
  throw new SlimeError('WRITE_REFUSED', 'SQL contains a write or a forbidden function; refused.', { details: { enforcedBy: 'lint' } });
}

export function lintArtifact(artifact: Artifact, input: Inputs): void {
  assertReadOnlySql(artifact.sql);
  assertPlaceholdersMapped(artifact, input);
  assertNoHardcodedInputs(artifact, input);
}

function assertPlaceholdersMapped({ sql, params }: Artifact, input: Inputs): void {
  const usedPlaceholders = placeholderNumbers(sql);
  const highestPlaceholder = Math.max(0, ...usedPlaceholders);
  if (highestPlaceholder > params.length) {
    throw invalidHandler(`SQL uses $${highestPlaceholder} but only ${params.length} params are mapped.`);
  }
  params.forEach((name, index) => {
    const placeholder = index + 1;
    if (!(name in input)) throw invalidHandler(`Param $${placeholder} maps to "${name}", which is not an input name.`);
    if (!usedPlaceholders.has(placeholder)) throw invalidHandler(`Param $${placeholder} ("${name}") is mapped but never used in the SQL.`);
  });
}

// The model never sees input values, so a value found in the code was copied from the intent.
function assertNoHardcodedInputs({ sql, shapeJs }: Artifact, input: Inputs): void {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.length < MIN_HARDCODED_LENGTH) continue;
    if (sql.includes(value) || shapeJs?.includes(value)) {
      throw invalidHandler(`The value of input "${name}" is hardcoded in the handler; use $n / input.${name}.`);
    }
  }
}

function placeholderNumbers(sql: string): Set<number> {
  return new Set([...sql.matchAll(PLACEHOLDER)].map(([, digits]) => Number(digits)));
}

function invalidHandler(message: string): SlimeError {
  return new SlimeError('INVALID_HANDLER', message);
}
