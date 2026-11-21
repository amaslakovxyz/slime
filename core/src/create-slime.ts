import type { SlimeConfig } from './config/slime-config.js';
import { buildDictionary, type Dictionary } from './dictionary/dictionary.js';
import { emitSafely } from './engine/events.js';
import { HANDLERS_NS } from './engine/handler-cache.js';
import { SlimeEngine } from './engine/slime-engine.js';
import type { HandlerRecord, Slime } from './engine/types.js';
import { SlimeConfigError } from './shared/errors.js';
import type { Connector } from './connectors/types.js';
import type { HandlerProvenance } from './request/key.js';
import { QuickJSRunner } from './sandbox/quickjs/quickjs-runner.js';
import type { SandboxRunner } from './sandbox/types.js';
import { startApiSources } from './sources/start-api-sources.js';
import type { ApiSchema } from './sources/types.js';
import { savedHandlerProblem } from './engine/saved-handler-check.js';
import { fileStore } from './stores/file-store.js';
import type { SlimeStore } from './stores/types.js';

// Locked mode has no generator and never compares these two fields (§4.7).
const LOCKED_MARKER = 'locked';
const HANDLER_KEY_PREFIX = 12;
const UNSAFE_CREDENTIALS = 'the connector refused to start: its database user can write or is too powerful';

export interface CreateSlimeOptions {
  /**
   * A sandbox shared with other engines in the process (one pool for many tenants). The
   * engine uses it and leaves it running on close(); the host closes it. Omit for the
   * engine's own runner, which close() stops.
   */
  runner?: SandboxRunner;
}

/** Startup order (§7, M2): safety check, store init, dictionary. */
export async function createSlime(config: SlimeConfig, options: CreateSlimeOptions = {}): Promise<Slime> {
  // The SQL source keeps today's calls and error text, so a setup without API sources starts exactly as before (MS3).
  await assertSafeCredentials(config.connector);
  const apiSchemas = await startApiSources(config);
  const store = config.store ?? fileStore();
  await store.init?.();
  const schema = await config.connector.describe();
  const dictionary = buildDictionary({ schema, glossary: config.glossary, rules: config.rules, apiSchemas, sqlSourceName: config.sqlSourceName });
  const provenance = currentProvenance(config, dictionary);
  if (config.mode === 'locked') await warnAboutOtherSchemas(config, store, provenance.schemaHash);
  if (config.mode === 'locked') await warnAboutUnfitHandlers(config, store, apiSchemas);
  // Crystal is SQL only, so an API source's change must not flag it (MS17).
  warnAboutOtherSchemaCrystals(config, dictionary.sourceHashes?.[config.sqlSourceName] ?? dictionary.schemaHash);
  const runner = options.runner ?? new QuickJSRunner();
  return new SlimeEngine({ config, store, runner, ownsRunner: !options.runner, dictionary, provenance, apiSchemas });
}

async function assertSafeCredentials(connector: Connector): Promise<void> {
  const report = await connector.safetyCheck();
  if (report.ok) return;
  throw new SlimeConfigError(report.problems.length > 0 ? report.problems : [UNSAFE_CREDENTIALS]);
}

function currentProvenance(config: SlimeConfig, dictionary: Dictionary): HandlerProvenance {
  const { generator } = config;
  return {
    schemaHash: dictionary.schemaHash,
    dictionaryHash: dictionary.hash,
    promptHash: (config.hasApiSources ? generator?.multiSourcePromptHash : generator?.promptHash) ?? LOCKED_MARKER,
    model: generator?.model ?? LOCKED_MARKER,
    ...(dictionary.sourceHashes ? { sourceHashes: dictionary.sourceHashes } : {}),
  };
}

/** Locked mode serves handlers made against another schema; it says so once, at startup (§4.7). */
async function warnAboutOtherSchemas(config: SlimeConfig, store: SlimeStore, schemaHash: string): Promise<void> {
  const saved = await store.list(HANDLERS_NS);
  const otherSchemaCount = saved.filter(({ value }) => (value as HandlerRecord).provenance.schemaHash !== schemaHash).length;
  if (otherSchemaCount === 0) return;
  emitSafely(config.onEvent, {
    type: 'warning',
    message: `${otherSchemaCount} saved handler(s) were made against another schema and are served as they are; regenerate them in development after a migration.`,
  });
}

/** Locked mode won't serve saved v2 handlers that no longer fit the sources; it lists them once, at startup (MS14). */
async function warnAboutUnfitHandlers(config: SlimeConfig, store: SlimeStore, apiSchemas: Readonly<Record<string, ApiSchema>>): Promise<void> {
  const context = { sqlSourceName: config.sqlSourceName, apiSchemas, maxSteps: config.limits.maxSteps };
  const unfit = (await store.list(HANDLERS_NS))
    .map(({ value }) => value as HandlerRecord)
    .map((record) => ({ key: record.key, problem: savedHandlerProblem(record, context) }))
    .filter((entry): entry is { key: string; problem: string } => entry.problem !== undefined);
  if (unfit.length === 0) return;
  const list = unfit.map(({ key, problem }) => `${key.slice(0, HANDLER_KEY_PREFIX)}: ${problem}`).join('; ');
  emitSafely(config.onEvent, { type: 'warning', message: `${unfit.length} saved multi-source handler(s) no longer fit the configured sources and are not served: ${list}` });
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
