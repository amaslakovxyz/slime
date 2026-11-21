// Rules for the `sources` option (MS1): one SQL source, any number of API sources.
import { isPlainObject } from '../shared/guards.js';

export const SQL_SOURCE_DEFAULT_NAME = 'db';
const SOURCE_NAME = /^[a-z][A-Za-z0-9]*$/;
const CONNECTOR_METHODS = ['describe', 'check', 'run', 'safetyCheck', 'close'];
const API_SOURCE_METHODS = ['describe', 'call', 'safetyCheck', 'close'];

const CONNECTOR_REQUIRED = 'connector is required: it tells Slime where the data comes from (or pass sources)';
const BOTH_GIVEN = 'connector and sources are both set: pass the database connector as one of sources, or use connector alone';
const SOURCES_NOT_OBJECT = 'sources must be an object of { name: source }, for example { db: postgresConnector(...) }';
const ONE_SQL_SOURCE = 'sources must contain exactly one SQL source (a connector); API sources go beside it';
// MS1: removed in P3.3, once the engine and prompts can use API sources.
const API_SOURCES_NOT_YET = 'API sources are not yet supported by this version of Slime';

/**
 * Lets core's own tests configure API sources before P3.3 removes the guard.
 * A symbol key: invisible to unknown-option checks, and not exported from the package.
 */
export const ALLOW_API_SOURCES = Symbol('allowApiSources');

export interface SourceOptions {
  connector?: unknown;
  sources?: unknown;
  [ALLOW_API_SOURCES]?: boolean;
}

export function sourceProblems(options: SourceOptions): string[] {
  const { connector, sources } = options;
  if (connector === undefined && sources === undefined) return [CONNECTOR_REQUIRED];
  if (connector !== undefined && sources !== undefined) return [BOTH_GIVEN];
  if (connector !== undefined) return missingMethods('connector', connector, CONNECTOR_METHODS);
  if (!isPlainObject(sources) || Object.keys(sources).length === 0) return [SOURCES_NOT_OBJECT];
  return [...namedSourceProblems(sources), ...sourceCountProblems(sources, options[ALLOW_API_SOURCES] === true)];
}

export function isApiSourceShape(source: unknown): boolean {
  return typeof source === 'object' && source !== null && (source as { kind?: unknown }).kind === 'api';
}

function namedSourceProblems(sources: Record<string, unknown>): string[] {
  return Object.entries(sources).flatMap(([name, source]) => {
    const label = `sources.${name}`;
    const nameProblems = SOURCE_NAME.test(name) ? [] : [`${label}: a source name starts with a lowercase letter and has only letters and digits`];
    if (!isApiSourceShape(source)) return [...nameProblems, ...missingMethods(label, source, CONNECTOR_METHODS)];
    const secrets = (source as Record<string, unknown>).secrets;
    const secretProblems = Array.isArray(secrets) && secrets.every((secret) => typeof secret === 'string') ? [] : [`${label}.secrets must be a list of strings`];
    return [...nameProblems, ...missingMethods(label, source, API_SOURCE_METHODS), ...secretProblems];
  });
}

function sourceCountProblems(sources: Record<string, unknown>, isApiAllowed: boolean): string[] {
  const values = Object.values(sources);
  const sqlCount = values.filter((source) => !isApiSourceShape(source)).length;
  const hasApi = values.some(isApiSourceShape);
  return [...(sqlCount === 1 ? [] : [ONE_SQL_SOURCE]), ...(hasApi && !isApiAllowed ? [API_SOURCES_NOT_YET] : [])];
}

export function missingMethods(optionName: string, value: unknown, methods: readonly string[]): string[] {
  if (!value || typeof value !== 'object') return [`${optionName} must be an object with ${methods.join(', ')}`];
  const fields = value as Record<string, unknown>;
  const missing = methods.filter((method) => typeof fields[method] !== 'function');
  if (missing.length === 0) return [];
  return [`${optionName} is missing ${missing.length > 1 ? 'methods' : 'method'} ${missing.join(', ')}`];
}
