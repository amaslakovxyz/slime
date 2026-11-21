// The startup safety check: Slime refuses credentials that could write (R8).
import type pg from 'pg';
import type { SafetyReport } from '../../ports.js';

interface RoleRow {
  user: string;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  is_rds_superuser: boolean;
}

const MAX_LISTED_TABLES = 5;

const ROLE_SQL = `
  SELECT current_user AS user, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
         EXISTS (SELECT 1 FROM pg_roles s WHERE s.rolname = 'rds_superuser'
                 AND pg_has_role(current_user, s.oid, 'member')) AS is_rds_superuser
  FROM pg_roles r WHERE r.rolname = current_user`;

const WRITABLE_TABLES_SQL = `
  SELECT n.nspname || '.' || c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
      OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))
  ORDER BY name
  LIMIT ${MAX_LISTED_TABLES}`;

export async function checkSafety(pool: pg.Pool): Promise<SafetyReport> {
  const [roles, writable] = await Promise.all([pool.query<RoleRow>(ROLE_SQL), pool.query<{ name: string }>(WRITABLE_TABLES_SQL)]);
  const role = roles.rows[0];
  if (!role) return { ok: false, user: 'unknown', problems: ['could not read the current role'] };

  const problems: string[] = [];
  if (role.rolsuper || role.is_rds_superuser) problems.push(`"${role.user}" is a superuser; use a dedicated read-only role.`);
  if (role.rolcreaterole || role.rolcreatedb) problems.push(`"${role.user}" can create roles or databases.`);
  if (writable.rows.length > 0) problems.push(`"${role.user}" can write to: ${writable.rows.map(({ name }) => name).join(', ')}.`);
  return { ok: problems.length === 0, user: role.user, problems };
}
