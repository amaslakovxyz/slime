import pg from 'pg';
import { config } from '../config.js';
import { SlimeError } from '../errors.js';
import type { Connector, RunResult, SafetyReport, SchemaInfo, TableInfo } from './types.js';

// pg returns int8 (COUNT, SUM of ints) and numeric as strings by default, which
// would break "number" fields in the requested output. Demo-scale values fit in a double.
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric

export class PostgresConnector implements Connector {
  readonly name = 'postgres';
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      // Client-side timeout, because generated SQL could lift the server-side one
      // with set_config(). On timeout the connection is destroyed (see run()).
      query_timeout: config.statementTimeoutMs + 1_000,
    });
  }

  async describe(): Promise<SchemaInfo> {
    const version = await this.pool.query<{ v: string }>(`SELECT current_setting('server_version') AS v`);
    // information_schema.columns lists only columns the current user can access,
    // so a column hidden by grants (password_hash) never reaches the prompt.
    const cols = await this.pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_comment: string | null;
      table_comment: string | null;
    }>(`
      SELECT c.table_name, c.column_name, c.data_type, c.is_nullable,
             col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) AS column_comment,
             obj_description(format('%I.%I', c.table_schema, c.table_name)::regclass, 'pg_class') AS table_comment
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND has_column_privilege(format('%I.%I', c.table_schema, c.table_name), c.column_name, 'SELECT')
      ORDER BY c.table_name, c.ordinal_position`);
    const keys = await this.pool.query<{
      table_name: string;
      contype: 'p' | 'f';
      column_name: string;
      ref_table: string | null;
      ref_column: string | null;
    }>(`
      SELECT con.conrelid::regclass::text AS table_name, con.contype, a.attname AS column_name,
             con.confrelid::regclass::text AS ref_table, af.attname AS ref_column
      FROM pg_constraint con
      CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, n)
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, n) ON fk.n = k.n
      LEFT JOIN pg_attribute af ON af.attrelid = con.confrelid AND af.attnum = fk.attnum
      WHERE con.contype IN ('p', 'f') AND con.connamespace = 'public'::regnamespace`);

    const tables = new Map<string, TableInfo>();
    for (const row of cols.rows) {
      let table = tables.get(row.table_name);
      if (!table) {
        table = { name: row.table_name, columns: [], primaryKey: [], foreignKeys: [] };
        if (row.table_comment) table.comment = row.table_comment;
        tables.set(row.table_name, table);
      }
      table.columns.push({
        name: row.column_name,
        type: row.data_type,
        nullable: row.is_nullable === 'YES',
        ...(row.column_comment ? { comment: row.column_comment } : {}),
      });
    }
    for (const key of keys.rows) {
      const table = tables.get(key.table_name);
      if (!table || !table.columns.some((c) => c.name === key.column_name)) continue;
      if (key.contype === 'p') table.primaryKey.push(key.column_name);
      else if (key.ref_table && tables.has(key.ref_table)) {
        table.foreignKeys.push({ column: key.column_name, references: `${key.ref_table}.${key.ref_column}` });
      }
    }
    return { dialect: `postgresql ${version.rows[0].v}`, tables: [...tables.values()] };
  }

  async check(sql: string, params: unknown[]): Promise<{ cost: number; ms: number }> {
    const started = performance.now();
    const res = await this.inReadOnlyTransaction((client) =>
      client.query<{ 'QUERY PLAN': [{ Plan: { 'Total Cost': number } }] }>({
        text: `EXPLAIN (FORMAT JSON) ${this.wrap(sql)}`,
        values: params,
      }),
    );
    const cost = res.rows[0]['QUERY PLAN'][0].Plan['Total Cost'];
    if (cost > config.maxQueryCost) {
      throw new SlimeError('QUERY_TOO_EXPENSIVE', `Planner cost ${Math.round(cost)} is above the cap of ${config.maxQueryCost}.`);
    }
    return { cost, ms: performance.now() - started };
  }

  async run(sql: string, params: unknown[]): Promise<RunResult> {
    const started = performance.now();
    const res = await this.inReadOnlyTransaction((client) => client.query({ text: this.wrap(sql), values: params }));
    const truncated = res.rows.length > config.rowCap;
    return { rows: truncated ? res.rows.slice(0, config.rowCap) : res.rows, truncated, ms: performance.now() - started };
  }

  async safetyCheck(): Promise<SafetyReport> {
    const role = await this.pool.query<{ user: string; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rds_superuser: boolean }>(`
      SELECT current_user AS user, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
             EXISTS (SELECT 1 FROM pg_roles s WHERE s.rolname = 'rds_superuser'
                     AND pg_has_role(current_user, s.oid, 'member')) AS rds_superuser
      FROM pg_roles r WHERE r.rolname = current_user`);
    const writable = await this.pool.query<{ name: string }>(`
      SELECT n.nspname || '.' || c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
          OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))
      LIMIT 5`);
    const r = role.rows[0];
    const problems: string[] = [];
    if (r.rolsuper || r.rds_superuser) problems.push(`"${r.user}" is a superuser; use a dedicated read-only role.`);
    if (r.rolcreaterole || r.rolcreatedb) problems.push(`"${r.user}" can create roles or databases.`);
    if (writable.rows.length) problems.push(`"${r.user}" can write to: ${writable.rows.map((w) => w.name).join(', ')}.`);
    return { ok: problems.length === 0, user: r.user, problems };
  }

  close() {
    return this.pool.end();
  }

  // Wrapping the generated SQL as a subquery does two jobs: anything that isn't a
  // single SELECT/WITH (e.g. "...; DROP TABLE x") becomes a syntax error, and the
  // outer LIMIT caps the rows. Postgres keeps an inner ORDER BY in this form.
  private wrap(sql: string): string {
    const body = sql.trim().replace(/;\s*$/, '');
    return `SELECT * FROM (\n${body}\n) AS slime_q LIMIT ${config.rowCap + 1}`;
  }

  private async inReadOnlyTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(config.statementTimeoutMs)}`);
      return await fn(client);
    } catch (err) {
      throw toSlimeError(err);
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      // Destroy rather than reuse a connection whose state we can't trust.
      client.release(broken);
    }
  }
}

function toSlimeError(err: unknown): SlimeError {
  if (err instanceof SlimeError) return err;
  const e = err as { code?: string; message?: string };
  const message = e.message ?? String(err);
  // 42501 insufficient_privilege: a table or column the read-only role can't see.
  if (e.code === '42501') return new SlimeError('FIELD_NOT_EXPOSED', `The database refused access: ${message}`);
  if (e.code === '25006') return new SlimeError('WRITE_REFUSED', `The database refused a write: ${message}`);
  if (e.code === '57014' || /timeout/i.test(message)) {
    return new SlimeError('EXECUTION_TIMEOUT', `Query exceeded ${config.statementTimeoutMs} ms.`, true);
  }
  return new SlimeError('QUERY_ERROR', message, false, e.code ? { sqlState: e.code } : undefined);
}
