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
  /** API sources by name; none keeps the text and hashes exactly as before multi-source (MS3). */
  apiSchemas?: Readonly<Record<string, ApiSchema>>;
  /** Named in the database heading when API sources are present. */
  sqlSourceName?: string;
}

export interface Dictionary {
  text: string;
  hash: string;
  schemaHash: string;
  /** One hash per source, present only with API sources (MS17). */
  sourceHashes?: Readonly<Record<string, string>>;
}

const DEFAULT_SQL_SOURCE_NAME = 'db';

export function buildDictionary({ schema, glossary, rules, apiSchemas = {}, sqlSourceName = DEFAULT_SQL_SOURCE_NAME }: DictionarySources): Dictionary {
  const apiEntries = Object.entries(apiSchemas);
  const hasApiSources = apiEntries.length > 0;
  // With API sources the model must know the database's source name; without one it named the step "postgresql" (P0.3).
  const databaseHeading = hasApiSources ? `Database ${sqlSourceName}: ${schema.dialect}` : `Database: ${schema.dialect}`;
  const sections = [
    databaseHeading,
    ...schema.tables.map(renderTable),
    ...apiEntries.map(([name, apiSchema]) => renderApiSource(name, apiSchema)),
    renderGlossary(glossary),
    renderRules(rules),
  ].filter((section) => section.length > 0);
  const text = sections.join('\n\n');
  if (!hasApiSources) return { text, hash: sha256(text), schemaHash: sha256(canonicalJSON(schema)) };
  const sourceHashes = Object.fromEntries([[sqlSourceName, sha256(canonicalJSON(schema))], ...apiEntries.map(([name, apiSchema]) => [name, sha256(canonicalJSON(apiSchema))])]);
  return { text, hash: sha256(text), schemaHash: sha256(canonicalJSON({ sql: schema, api: apiSchemas })), sourceHashes };
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
