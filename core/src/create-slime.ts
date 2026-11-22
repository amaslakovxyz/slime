import type { SlimeConfig } from './config/slime-config.js';
import { buildDictionary, type Dictionary } from './dictionary/dictionary.js';
import { emitSafely } from './engine/events.js';
import { HANDLERS_NS, recordFromStore } from './handler/record.js';
import { sourceSetup } from './engine/engine-deps.js';
import { SlimeEngine } from './engine/slime-engine.js';
import type { Slime } from './engine/types.js';
import type { HandlerProvenance } from './request/key.js';
import { QuickJSRunner } from './sandbox/quickjs/quickjs-runner.js';
import type { SandboxRunner } from './sandbox/types.js';
import { startSources } from './sources/lifecycle.js';
import type { ApiSchema } from './sources/api/types.js';
import { savedHandlerProblem } from './handler/fits-sources.js';
import { fileStore } from './stores/file-store.js';
import type { SlimeStore } from './stores/types.js';

// Locked mode has no generator and never compares these two fields (§4.7).
const LOCKED_MARKER = 'locked';
const HANDLER_KEY_PREFIX = 12;

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
  if (config.mode === 'locked') await warnAboutOtherSchemas(config, store, provenance.schemaHash);
  if (config.mode === 'locked') await warnAboutUnfitHandlers(config, store, apiSchemas);
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
    promptHash: generator?.promptHash ?? LOCKED_MARKER,
    model: generator?.model ?? LOCKED_MARKER,
    sourceHashes: dictionary.sourceHashes,
  };
}

/** Locked mode serves handlers made against another schema; it says so once, at startup (§4.7). */
async function warnAboutOtherSchemas(config: SlimeConfig, store: SlimeStore, schemaHash: string): Promise<void> {
  const saved = await store.list(HANDLERS_NS);
  const otherSchemaCount = saved.filter(({ value }) => recordFromStore(value, config.sqlSourceName).provenance.schemaHash !== schemaHash).length;
  if (otherSchemaCount === 0) return;
  emitSafely(config.onEvent, {
    type: 'warning',
    message: `${otherSchemaCount} saved handler(s) were made against another schema and are served as they are; regenerate them in development after a migration.`,
  });
}

/** Locked mode won't serve saved handlers that no longer fit the sources; it lists them once, at startup (MS14). */
async function warnAboutUnfitHandlers(config: SlimeConfig, store: SlimeStore, apiSchemas: Readonly<Record<string, ApiSchema>>): Promise<void> {
  const context = { sqlSourceName: config.sqlSourceName, apiSchemas, maxSteps: config.limits.maxSteps };
  const unfit = (await store.list(HANDLERS_NS))
    .map(({ value }) => recordFromStore(value, config.sqlSourceName))
    .map((record) => ({ key: record.key, problem: savedHandlerProblem(record, context) }))
    .filter((entry): entry is { key: string; problem: string } => entry.problem !== undefined);
  if (unfit.length === 0) return;
  const list = unfit.map(({ key, problem }) => `${key.slice(0, HANDLER_KEY_PREFIX)}: ${problem}`).join('; ');
  emitSafely(config.onEvent, { type: 'warning', message: `${unfit.length} saved handler(s) no longer fit the configured sources and are not served: ${list}` });
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
