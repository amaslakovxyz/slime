// The dependency bundles the engine hands to execution, generation and Crystal.
import type { Generator } from '../models/types.js';
import type { ExecutionDeps } from './execute.js';
import type { GenerationDeps } from './generate.js';
import type { EngineParts } from './slime-engine.js';

export function executionDeps({ config, runner, apiSchemas }: EngineParts): ExecutionDeps {
  return { connector: config.connector, sources: config.sources, apiSchemas, runner, limits: config.limits };
}

/** v2 generation only when the instance has API sources, so v1 setups send exactly what they did before (MS3). */
export function generationDeps(parts: EngineParts, generator: Generator): GenerationDeps {
  const { config, dictionary, provenance } = parts;
  const multiSource = config.hasApiSources ? { format: 'v2' as const, sqlSourceName: config.sqlSourceName } : {};
  return { generator, ...executionDeps(parts), dictionaryText: dictionary.text, provenance, ...multiSource };
}
