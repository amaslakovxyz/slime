// The dictionary (§4.4, D2): metadata, glossary and rules rendered as text, with
// no model, so the same inputs always give the same text and hash.
import type { SchemaInfo, TableInfo } from '../connectors/types.js';
import { canonicalJSON, sha256 } from '../shared/hash.js';
import type { ApiSchema } from '../sources/types.js';
import { renderApiSource } from './api-section.js';
import { INDENT, renderColumn, withComment } from './columns.js';

export interface DictionarySources {
  schema: SchemaInfo;
  glossary: Readonly<Record<string, string>>;
  rules: readonly string[];
  /** API sources by name. */
  apiSchemas?: Readonly<Record<string, ApiSchema>>;
  sqlSourceName: string;
}

export interface Dictionary {
  text: string;
  hash: string;
  schemaHash: string;
  /** One hash per source (MS17). */
  sourceHashes: Readonly<Record<string, string>>;
}

export function buildDictionary({ schema, glossary, rules, apiSchemas = {}, sqlSourceName }: DictionarySources): Dictionary {
  const apiEntries = Object.entries(apiSchemas);
  // Every step names its source, so the model needs the database's name. Quoted: unquoted, a model took the
  // whole heading ("db: postgresql 16.15 (Debian ...)") as the name (P0.3, P3.4).
  const sections = [
    `Database source "${sqlSourceName}": ${schema.dialect}`,
    ...schema.tables.map(renderTable),
    ...apiEntries.map(([name, apiSchema]) => renderApiSource(name, apiSchema)),
    renderGlossary(glossary),
    renderRules(rules),
  ].filter((section) => section.length > 0);
  const text = sections.join('\n\n');
  const sqlSchemaHash = sha256(canonicalJSON(schema));
  const sourceHashes = Object.fromEntries([[sqlSourceName, sqlSchemaHash], ...apiEntries.map(([name, apiSchema]) => [name, sha256(canonicalJSON(apiSchema))])]);
  // A database alone keeps the database's hash, so saved handlers and Crystal made before API sources still match (C10).
  const schemaHash = apiEntries.length === 0 ? sqlSchemaHash : sha256(canonicalJSON({ sql: schema, api: apiSchemas }));
  return { text, hash: sha256(text), schemaHash, sourceHashes };
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


function renderGlossary(glossary: Readonly<Record<string, string>>): string {
  const entries = Object.entries(glossary);
  if (entries.length === 0) return '';
  return ['Glossary:', ...entries.map(([word, meaning]) => `${INDENT}${word}: ${meaning}`)].join('\n');
}

function renderRules(rules: readonly string[]): string {
  if (rules.length === 0) return '';
  return ['Rules:', ...rules.map((rule) => `${INDENT}- ${rule}`)].join('\n');
}
