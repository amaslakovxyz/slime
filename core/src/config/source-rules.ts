// Rules for the `sources` option (MS1): one SQL source, any number of API sources.
import { isPlainObject } from '../shared/guards.js';

export const SQL_SOURCE_DEFAULT_NAME = 'db';
const SOURCE_NAME = /^[a-z][A-Za-z0-9]*$/;
const CONNECTOR_METHODS = ['describe', 'check', 'run', 'safetyCheck', 'close'];
const API_SOURCE_METHODS = ['describe', 'call', 'safetyCheck', 'close'];

const CONNECTOR_REQUIRED = 'connector is required: it tells Slime where the data comes from (or pass sources)';
const BOTH_GIVEN = 'connector and sources are both set: pass the database connector as one of sources, or use connector alone';
const SOURCES_NOT_OBJECT = 'sources must be an object of { name: source }, for example { db: postgresConnector(...) }';
const GENERATOR_NOT_MULTI_SOURCE = 'generator has no multiSourcePromptHash, so it cannot write handlers for API sources; use a built-in generator or add it';
const ONE_SQL_SOURCE = 'sources must contain exactly one SQL source (a connector); API sources go beside it';
export interface SourceOptions {
  connector?: unknown;
  sources?: unknown;
  generator?: unknown;
}

export function sourceProblems(options: SourceOptions): string[] {
  const { connector, sources } = options;
  if (connector === undefined && sources === undefined) return [CONNECTOR_REQUIRED];
  if (connector !== undefined && sources !== undefined) return [BOTH_GIVEN];
  if (connector !== undefined) return missingMethods('connector', connector, CONNECTOR_METHODS);
  if (!isPlainObject(sources) || Object.keys(sources).length === 0) return [SOURCES_NOT_OBJECT];
  return [...namedSourceProblems(sources), ...sourceCountProblems(sources), ...generatorProblems(sources, options.generator)];
}

function isApiSourceShape(source: unknown): boolean {
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

function sourceCountProblems(sources: Record<string, unknown>): string[] {
  const sqlCount = Object.values(sources).filter((source) => !isApiSourceShape(source)).length;
  return sqlCount === 1 ? [] : [ONE_SQL_SOURCE];
}

// The generator's multi-source prompt hash is what v2 handlers record (MS3).
function generatorProblems(sources: Record<string, unknown>, generator: unknown): string[] {
  if (!generator || typeof generator !== 'object' || !Object.values(sources).some(isApiSourceShape)) return [];
  const hash = (generator as { multiSourcePromptHash?: unknown }).multiSourcePromptHash;
  return typeof hash === 'string' && hash.length > 0 ? [] : [GENERATOR_NOT_MULTI_SOURCE];
}

export function missingMethods(optionName: string, value: unknown, methods: readonly string[]): string[] {
  if (!value || typeof value !== 'object') return [`${optionName} must be an object with ${methods.join(', ')}`];
  const fields = value as Record<string, unknown>;
  const missing = methods.filter((method) => typeof fields[method] !== 'function');
  if (missing.length === 0) return [];
  return [`${optionName} is missing ${missing.length > 1 ? 'methods' : 'method'} ${missing.join(', ')}`];
}
