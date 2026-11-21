// Startup for API sources (MS8): every safety check, then every schema, through
// callSource so a failure is time-limited and its message redacted (MS16).
import type { SlimeConfig } from '../config/slime-config.js';
import { SlimeConfigError } from '../shared/errors.js';
import { callSource } from './call-source.js';
import { redactSecrets } from './redact.js';
import { isApiSource, type ApiSchema, type ApiSource } from './types.js';

interface NamedApiSource {
  name: string;
  source: ApiSource;
}

/** The API schemas by source name; throws one SlimeConfigError that names each failing source. */
export async function startApiSources(config: SlimeConfig): Promise<Record<string, ApiSchema>> {
  const sources = apiSourcesOf(config);
  if (sources.length === 0) return {};
  const timeoutMs = config.limits.apiTimeoutMs;
  throwIfAny(await Promise.all(sources.map(({ name, source }) => safetyProblems(name, source, timeoutMs))));
  const described = await Promise.allSettled(
    sources.map(({ name, source }) => callSource({ sourceName: name, method: 'describe', secrets: source.secrets, timeoutMs, run: (options) => source.describe(options) })),
  );
  throwIfAny(described.map((result) => (result.status === 'rejected' ? [String((result.reason as Error).message)] : [])));
  return Object.fromEntries(sources.map(({ name }, index) => [name, (described[index] as PromiseFulfilledResult<ApiSchema>).value]));
}

function apiSourcesOf(config: SlimeConfig): NamedApiSource[] {
  return config.apiSourceNames.map((name) => ({ name, source: config.sources[name] })).filter((entry): entry is NamedApiSource => entry.source !== undefined && isApiSource(entry.source));
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

function throwIfAny(problemLists: string[][]): void {
  const problems = problemLists.flat();
  if (problems.length > 0) throw new SlimeConfigError(problems);
}
