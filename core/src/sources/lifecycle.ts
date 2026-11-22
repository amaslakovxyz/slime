// Starting and closing every configured source (MS8). API sources go through
// callSource, so each call is time-limited and its message redacted (MS16); the
// SQL source keeps its own calls and errors, with no extra deadline (MS3).
import { SlimeConfigError } from '../shared/errors.js';
import type { Connector, SchemaInfo } from './sql/types.js';
import { callSource } from './api/call-source.js';
import { redactSecrets } from './api/redact.js';
import type { ApiSchema, ApiSource } from './api/types.js';
import { isApiSource, type Source } from './types.js';

export interface SourceSetup {
  sources: Readonly<Record<string, Source>>;
  sqlSourceName: string;
  apiTimeoutMs: number;
}

export interface StartedSources {
  schema: SchemaInfo;
  /** By source name; empty without API sources. */
  apiSchemas: Record<string, ApiSchema>;
}

interface NamedApiSource {
  name: string;
  source: ApiSource;
}

const UNSAFE_CREDENTIALS = 'the connector refused to start: its database user can write or is too powerful';

/** Every safety check first, then every schema; throws one SlimeConfigError naming each failing source. */
export async function startSources(setup: SourceSetup): Promise<StartedSources> {
  const sql = sqlSourceOf(setup);
  const apiSources = apiSourcesOf(setup);
  await assertSafeCredentials(sql);
  throwIfAny(await Promise.all(apiSources.map(({ name, source }) => safetyProblems(name, source, setup.apiTimeoutMs))));
  const [schema, ...described] = await Promise.allSettled([sql.describe(), ...apiSources.map((entry) => describeApi(entry, setup.apiTimeoutMs))]);
  if (schema?.status === 'rejected') throw schema.reason;
  throwIfAny(described.map((result) => (result.status === 'rejected' ? [String((result.reason as Error).message)] : [])));
  const apiSchemas = Object.fromEntries(apiSources.map(({ name }, index) => [name, (described[index] as PromiseFulfilledResult<ApiSchema>).value]));
  return { schema: (schema as PromiseFulfilledResult<SchemaInfo>).value, apiSchemas };
}

/** Closes every source; one failing close doesn't stop the others. Rejects with the first failure. */
export async function closeSources(setup: SourceSetup): Promise<void> {
  const closed = await Promise.allSettled(
    Object.entries(setup.sources).map(([name, source]) =>
      isApiSource(source) ? callSource({ sourceName: name, method: 'close', secrets: source.secrets, timeoutMs: setup.apiTimeoutMs, run: () => source.close() }) : source.close(),
    ),
  );
  const failed = closed.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}

function sqlSourceOf({ sources, sqlSourceName }: SourceSetup): Connector {
  return sources[sqlSourceName] as Connector;
}

function apiSourcesOf({ sources }: SourceSetup): NamedApiSource[] {
  return Object.entries(sources)
    .filter((entry): entry is [string, ApiSource] => isApiSource(entry[1]))
    .map(([name, source]) => ({ name, source }));
}

async function assertSafeCredentials(connector: Connector): Promise<void> {
  const report = await connector.safetyCheck();
  if (report.ok) return;
  throw new SlimeConfigError(report.problems.length > 0 ? report.problems : [UNSAFE_CREDENTIALS]);
}

async function safetyProblems(name: string, source: ApiSource, timeoutMs: number): Promise<string[]> {
  try {
    const report = await callSource({ sourceName: name, method: 'safetyCheck', secrets: source.secrets, timeoutMs, run: (options) => source.safetyCheck(options) });
    if (report.ok) return [];
    const problems = report.problems.length > 0 ? report.problems : ['its safety check failed'];
    return problems.map((problem) => redactSecrets(`${name}: ${problem}`, source.secrets));
  } catch (error) {
    return [(error as Error).message];
  }
}

function describeApi({ name, source }: NamedApiSource, timeoutMs: number): Promise<ApiSchema> {
  return callSource({ sourceName: name, method: 'describe', secrets: source.secrets, timeoutMs, run: (options) => source.describe(options) });
}

function throwIfAny(problemLists: string[][]): void {
  const problems = problemLists.flat();
  if (problems.length > 0) throw new SlimeConfigError(problems);
}
