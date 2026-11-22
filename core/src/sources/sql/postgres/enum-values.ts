// Allowed values of enum-like columns, from the catalog, never from rows (D1):
// Postgres enum types and single-column CHECK … IN (…) constraints.
import type pg from 'pg';

/** Keyed by "table.column". */
export type EnumValues = Map<string, string[]>;

interface EnumTypeRow {
  table_name: string;
  column_name: string;
  labels: string[];
}

interface CheckRow {
  table_name: string;
  column_name: string;
  definition: string;
}

const ENUM_TYPES_SQL = `
  SELECT c.table_name, c.column_name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
  FROM information_schema.columns c
  JOIN pg_namespace n ON n.nspname = c.udt_schema
  JOIN pg_type t ON t.typname = c.udt_name AND t.typnamespace = n.oid
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE c.table_schema = $1
  GROUP BY c.table_name, c.column_name`;

const SINGLE_COLUMN_CHECKS_SQL = `
  SELECT rel.relname AS table_name, a.attname AS column_name, pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
  WHERE con.contype = 'c' AND con.connamespace = $1::regnamespace AND cardinality(con.conkey) = 1`;

// Postgres stores "status IN ('a', 'b')" as "status = ANY (ARRAY['a'::text, 'b'::text])".
const ANY_ARRAY = /= ANY \(\(?ARRAY\[(.*)\]/;
const QUOTED_LITERAL = /'((?:[^']|'')*)'/g;

export async function readEnumValues(pool: pg.Pool, schema: string): Promise<EnumValues> {
  const [enumTypes, checks] = await Promise.all([
    pool.query<EnumTypeRow>(ENUM_TYPES_SQL, [schema]),
    pool.query<CheckRow>(SINGLE_COLUMN_CHECKS_SQL, [schema]),
  ]);
  const valuesByColumn: EnumValues = new Map();
  for (const { table_name, column_name, definition } of checks.rows) {
    const values = valuesInCheck(definition);
    if (values) valuesByColumn.set(`${table_name}.${column_name}`, values);
  }
  for (const { table_name, column_name, labels } of enumTypes.rows) valuesByColumn.set(`${table_name}.${column_name}`, labels);
  return valuesByColumn;
}

export function valuesInCheck(definition: string): string[] | undefined {
  const list = ANY_ARRAY.exec(definition)?.[1];
  if (!list) return undefined;
  const values = [...list.matchAll(QUOTED_LITERAL)].map(([, literal]) => literal!.replaceAll("''", "'"));
  return values.length > 0 ? values : undefined;
}
