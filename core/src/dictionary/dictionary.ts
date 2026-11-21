// The dictionary (§4.4, D2): metadata, glossary and rules rendered as text, with
// no model, so the same inputs always give the same text and hash.
import type { ColumnInfo, SchemaInfo, TableInfo } from '../connectors/types.js';
import { canonicalJSON, sha256 } from '../shared/hash.js';

export interface DictionarySources {
  schema: SchemaInfo;
  glossary: Readonly<Record<string, string>>;
  rules: readonly string[];
}

export interface Dictionary {
  text: string;
  hash: string;
  schemaHash: string;
}

const INDENT = '  ';

export function buildDictionary({ schema, glossary, rules }: DictionarySources): Dictionary {
  const sections = [
    `Database: ${schema.dialect}`,
    ...schema.tables.map(renderTable),
    renderGlossary(glossary),
    renderRules(rules),
  ].filter((section) => section.length > 0);
  const text = sections.join('\n\n');
  return { text, hash: sha256(text), schemaHash: sha256(canonicalJSON(schema)) };
}

function renderTable(table: TableInfo): string {
  const heading = withComment(`Table ${table.name}`, table.comment);
  const references = new Map(table.foreignKeys.map(({ column, references: target }) => [column, target]));
  const columns = table.columns.map((column) => {
    const isPrimaryKey = table.primaryKey.includes(column.name);
    return `${INDENT}${renderColumn(column, { isPrimaryKey, references: references.get(column.name) })}`;
  });
  return [heading, ...columns].join('\n');
}

interface ColumnKeys {
  isPrimaryKey: boolean;
  references: string | undefined;
}

function renderColumn(column: ColumnInfo, { isPrimaryKey, references }: ColumnKeys): string {
  const parts = [column.name, column.type, column.nullable ? 'null' : 'not null'];
  if (isPrimaryKey) parts.push('primary key');
  if (references) parts.push(`references ${references}`);
  if (column.values?.length) parts.push(`one of: ${column.values.join(', ')}`);
  return withComment(parts.join(' '), column.comment);
}

function renderGlossary(glossary: Readonly<Record<string, string>>): string {
  const entries = Object.entries(glossary);
  if (entries.length === 0) return '';
  return ['Glossary:', ...entries.map(([word, meaning]) => `${INDENT}${word}: ${meaning}`)].join('\n');
}

function renderRules(rules: readonly string[]): string {
  if (rules.length === 0) return '';
  return ['Rules:', ...rules.map((rule) => `${INDENT}- ${rule}`)].join('\n');
}

function withComment(text: string, comment: string | undefined): string {
  return comment ? `${text} -- ${comment}` : text;
}
