import type { SlimeConfig } from './config/slime-config.js';
import { buildDictionary, type Dictionary } from './dictionary/dictionary.js';
import { emitSafely } from './engine/events.js';
import { sourceSetup } from './engine/engine-deps.js';
import { SlimeEngine } from './engine/slime-engine.js';
import type { Slime } from './engine/types.js';
import type { HandlerProvenance } from './request/key.js';
import { QuickJSRunner } from './sandbox/quickjs/quickjs-runner.js';
import type { SandboxRunner } from './sandbox/types.js';
import { startSources } from './sources/lifecycle.js';
import { fileStore } from './stores/file-store.js';

export interface CreateSlimeOptions {
  /**
   * A sandbox shared with other engines in the process (one pool for many tenants). The
   * engine uses it and leaves it running on close(); the host closes it. Omit for the
   * engine's own runner, which close() stops.
   */
  runner?: SandboxRunner;
}

/** Startup order (§7, M2): every source's safety check and schema, store init, dictionary. */
export async function createSlime(config: SlimeConfig, options: CreateSlimeOptions = {}): Promise<Slime> {
  const { schema, apiSchemas } = await startSources(sourceSetup(config));
  const store = config.store ?? fileStore();
  await store.init?.();
  const dictionary = buildDictionary({ schema, glossary: config.glossary, rules: config.rules, apiSchemas, sqlSourceName: config.sqlSourceName });
  const provenance = currentProvenance(config, dictionary);
  // Crystal is SQL only, so an API source's change must not flag it (MS17).
  warnAboutOtherSchemaCrystals(config, dictionary.sourceHashes[config.sqlSourceName] ?? dictionary.schemaHash);
  const runner = options.runner ?? new QuickJSRunner();
  return new SlimeEngine({ config, store, runner, ownsRunner: !options.runner, dictionary, provenance, apiSchemas });
}

function currentProvenance(config: SlimeConfig, dictionary: Dictionary): HandlerProvenance {
  const { generator } = config;
  return {
    schemaHash: dictionary.schemaHash,
    dictionaryHash: dictionary.hash,
    promptHash: generator.promptHash,
    model: generator.model,
    sourceHashes: dictionary.sourceHashes,
  };
}

/** Crystal ships with the app and is served as it is; a schema change is reported once, at startup (C10). */
function warnAboutOtherSchemaCrystals(config: SlimeConfig, schemaHash: string): void {
  const crystals = config.crystal ? Object.values(config.crystal) : [];
  const otherSchemaCount = crystals.filter((crystal) => crystal.schemaHash !== schemaHash).length;
  if (otherSchemaCount === 0) return;
  emitSafely(config.onEvent, {
    type: 'warning',
    message: `${otherSchemaCount} Crystal handler(s) were made against another schema and are served as they are; run crystallize again after a migration.`,
  });
}
