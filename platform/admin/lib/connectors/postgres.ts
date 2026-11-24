// Connection test for a customer Postgres URL (PostgreSQL or Supabase connector),
// run from the admin's network. The role checks mirror the runtime's safetyCheck
// (core/src/sources/sql/postgres/safety.ts), which gates `ready`, so a URL that passes here should pass there.
import pg from 'pg';
import { validateConnectionUrl } from '../connectors';

export interface ConnectionTest {
  ok: boolean;
  user: string | null;
  database: string | null;
  serverVersion: string | null;
  /** Tables (incl. partitioned) outside the system schemas that the role can read. */
  tables: number | null;
  /** Unsafe role: the runtime refuses to start, so `ok` is false. */
  problems: string[];
  /** Safe but surprising, e.g. RLS hiding every row; `ok` stays true. */
  warnings: string[];
  error?: string;
}

const USER_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'`;
const NAMES_SHOWN = 5;

export async function testConnection(connectorType: string, databaseUrl: string): Promise<ConnectionTest> {
  const result: ConnectionTest = {
    ok: false,
    user: null,
    database: null,
    serverVersion: null,
    tables: null,
    problems: [],
    warnings: [],
  };
  let connectionString: string;
  try {
    connectionString = validateConnectionUrl(connectorType, databaseUrl);
  } catch (err) {
    return { ...result, error: (err as Error).message };
  }
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    application_name: 'slime-admin',
  });
  // A dropped socket after connect emits 'error'; the awaited calls report it.
  client.on('error', () => {});
  try {
    await client.connect();
    const role = await client.query<{
      user: string;
      database: string;
      version: string;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rds_superuser: boolean;
    }>(`
      SELECT current_user AS user, current_database() AS database, current_setting('server_version') AS version,
             r.rolsuper, r.rolcreaterole, r.rolcreatedb,
             EXISTS (SELECT 1 FROM pg_roles s WHERE s.rolname = 'rds_superuser'
                     AND pg_has_role(current_user, s.oid, 'member')) AS rds_superuser
      FROM pg_roles r WHERE r.rolname = current_user`);
    const writable = await client.query<{ name: string }>(`
      SELECT n.nspname || '.' || c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm') AND ${USER_SCHEMAS}
        AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
          OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))
      LIMIT 5`);
    // Only what the role can read (column grants count): Slime can't query the rest, so counting it misleads (E2E-16).
    const tables = await client.query<{ count: string }>(`
      SELECT count(*) AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND ${USER_SCHEMAS}
        AND has_schema_privilege(n.oid, 'USAGE') AND has_any_column_privilege(c.oid, 'SELECT')`);
    // Readable tables whose RLS lets no row through to this role: no BYPASSRLS, not the
    // owner (owners bypass unless FORCE), and no permissive SELECT policy for it or PUBLIC.
    // Supabase's ensure_rls event trigger enables RLS on every new public table, with policies only for anon/authenticated.
    const hidden = await client.query<{ name: string }>(`
      SELECT n.nspname || '.' || c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND ${USER_SCHEMAS} AND c.relrowsecurity
        AND has_schema_privilege(n.oid, 'USAGE') AND has_any_column_privilege(c.oid, 'SELECT')
        AND NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)
        AND (c.relforcerowsecurity OR NOT pg_has_role(current_user, c.relowner, 'USAGE'))
        AND NOT EXISTS (
          SELECT 1 FROM pg_policy p
          WHERE p.polrelid = c.oid AND p.polpermissive AND p.polcmd IN ('r', '*')
            AND (0 = ANY (p.polroles) OR EXISTS (
              SELECT 1 FROM unnest(p.polroles) AS pr(oid) WHERE pg_has_role(current_user, pr.oid, 'USAGE'))))
      ORDER BY 1
      LIMIT ${NAMES_SHOWN + 1}`);

    const r = role.rows[0];
    const problems: string[] = [];
    if (r.rolsuper || r.rds_superuser) problems.push(`"${r.user}" is a superuser; use a dedicated read-only role.`);
    if (r.rolcreaterole || r.rolcreatedb) problems.push(`"${r.user}" can create roles or databases.`);
    if (writable.rows.length) problems.push(`"${r.user}" can write to: ${writable.rows.map((w) => w.name).join(', ')}.`);
    const warnings: string[] = [];
    if (hidden.rows.length) {
      const names = hidden.rows.slice(0, NAMES_SHOWN).map((h) => h.name);
      const more = hidden.rows.length > NAMES_SHOWN ? ' and more' : '';
      warnings.push(
        `Row level security hides every row from "${r.user}" in: ${names.join(', ')}${more}. Add a SELECT policy for the role or grant it BYPASSRLS.`,
      );
    }
    return {
      ok: problems.length === 0,
      user: r.user,
      database: r.database,
      serverVersion: r.version,
      tables: Number(tables.rows[0].count),
      problems,
      warnings,
    };
  } catch (err) {
    // ECONNREFUSED on a dual-stack host arrives as an AggregateError with an empty message.
    const e = err as Error & { code?: string };
    return { ...result, error: e.message || e.code || String(err) };
  } finally {
    await client.end().catch(() => {});
  }
}
