import type pg from 'pg';
import type { SchemaInfo, TableInfo } from '../types.js';
import { readEnumValues, type EnumValues } from './enum-values.js';

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_comment: string | null;
  table_comment: string | null;
}

interface KeyRow {
  table_name: string;
  contype: 'p' | 'f';
  column_name: string;
  ref_table: string | null;
  ref_column: string | null;
}

const VERSION_SQL = `SELECT current_setting('server_version') AS version`;

// Only columns these credentials may SELECT, so a hidden column (password_hash) never reaches a prompt.
const COLUMNS_SQL = `
  SELECT c.table_name, c.column_name, c.data_type, c.is_nullable,
         col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) AS column_comment,
         obj_description(format('%I.%I', c.table_schema, c.table_name)::regclass, 'pg_class') AS table_comment
  FROM information_schema.columns c
  WHERE c.table_schema = $1
    AND has_column_privilege(format('%I.%I', c.table_schema, c.table_name), c.column_name, 'SELECT')
  ORDER BY c.table_name, c.ordinal_position`;

const KEYS_SQL = `
  SELECT rel.relname AS table_name, con.contype, a.attname AS column_name, ref.relname AS ref_table, ref_a.attname AS ref_column
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  LEFT JOIN pg_class ref ON ref.oid = con.confrelid
  CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, position)
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
  LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, position) ON fk.position = k.position
  LEFT JOIN pg_attribute ref_a ON ref_a.attrelid = con.confrelid AND ref_a.attnum = fk.attnum
  WHERE con.contype IN ('p', 'f') AND con.connamespace = $1::regnamespace
  ORDER BY rel.relname, con.conname, k.position`;

export async function describeSchema(pool: pg.Pool, schema: string): Promise<SchemaInfo> {
  const [version, columns, keys, enumValues] = await Promise.all([
    pool.query<{ version: string }>(VERSION_SQL),
    pool.query<ColumnRow>(COLUMNS_SQL, [schema]),
    pool.query<KeyRow>(KEYS_SQL, [schema]),
    readEnumValues(pool, schema),
  ]);
  const tables = tablesFrom(columns.rows, enumValues);
  addKeys(tables, keys.rows);
  return { dialect: `postgresql ${version.rows[0]?.version}`, tables: [...tables.values()] };
}

function tablesFrom(rows: ColumnRow[], enumValues: EnumValues): Map<string, TableInfo> {
  const tables = new Map<string, TableInfo>();
  for (const row of rows) {
    const table = tables.get(row.table_name) ?? newTable(row);
    tables.set(row.table_name, table);
    const values = enumValues.get(`${row.table_name}.${row.column_name}`);
    table.columns.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
      ...(row.column_comment ? { comment: row.column_comment } : {}),
      ...(values ? { values } : {}),
    });
  }
  return tables;
}

function newTable({ table_name, table_comment }: ColumnRow): TableInfo {
  return { name: table_name, columns: [], primaryKey: [], foreignKeys: [], ...(table_comment ? { comment: table_comment } : {}) };
}

// Keys on hidden columns, or pointing at tables these credentials can't see, are left out.
function addKeys(tables: Map<string, TableInfo>, rows: KeyRow[]): void {
  for (const { table_name, contype, column_name, ref_table, ref_column } of rows) {
    const table = tables.get(table_name);
    if (!table?.columns.some(({ name }) => name === column_name)) continue;
    if (contype === 'p') table.primaryKey.push(column_name);
    else if (ref_table && ref_column && tables.has(ref_table)) table.foreignKeys.push({ column: column_name, references: `${ref_table}.${ref_column}` });
  }
}
