// The dependency bundles the engine hands to execution, generation and Crystal.
import type { SlimeConfig } from '../config/slime-config.js';
import type { Generator } from '../models/types.js';
import type { SourceSetup } from '../sources/lifecycle.js';
import type { ExecutionDeps } from './execution/execute.js';
import type { GenerationDeps } from './generation/generate.js';
import type { EngineParts } from './slime-engine.js';

export function executionDeps({ config, runner, apiSchemas }: EngineParts): ExecutionDeps {
  return { connector: config.connector, sources: config.sources, apiSchemas, runner, limits: config.limits };
}

export function generationDeps(parts: EngineParts, generator: Generator): GenerationDeps {
  const { config, dictionary, provenance } = parts;
  return { generator, ...executionDeps(parts), dictionaryText: dictionary.text, provenance, sqlSourceName: config.sqlSourceName };
}

export function sourceSetup({ sources, sqlSourceName, limits }: SlimeConfig): SourceSetup {
  return { sources, sqlSourceName, apiTimeoutMs: limits.apiTimeoutMs };
}
