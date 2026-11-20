import { SlimeError } from './errors.js';

// Defence in depth only: the read-only database user is the real boundary.
const WRITE_SQL = /\b(insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|vacuum|set_config|pg_sleep|pg_read_file|lo_import|dblink)\b/i;

export function assertReadOnlySql(sql: string): void {
  if (WRITE_SQL.test(sql)) {
    throw new SlimeError('WRITE_REFUSED', 'SQL contains a write or a forbidden function; refused.', false, { enforcedBy: 'lint' });
  }
}
