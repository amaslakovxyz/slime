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
import { fileStore } from './stores/file-store.js';
import type { SlimeStore } from './stores/types.js';

// Locked mode has no generator and never compares these two fields (§4.7).
const LOCKED_MARKER = 'locked';
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
  await assertSafeCredentials(config.connector);
  const store = config.store ?? fileStore();
  await store.init?.();
  const dictionary = buildDictionary({ schema: await config.connector.describe(), glossary: config.glossary, rules: config.rules });
  const provenance = currentProvenance(config, dictionary);
  if (config.mode === 'locked') await warnAboutOtherSchemas(config, store, provenance.schemaHash);
  warnAboutOtherSchemaCrystals(config, provenance.schemaHash);
  const runner = options.runner ?? new QuickJSRunner();
  return new SlimeEngine({ config, store, runner, ownsRunner: !options.runner, dictionary, provenance });
}

async function assertSafeCredentials(connector: Connector): Promise<void> {
  const report = await connector.safetyCheck();
  if (report.ok) return;
  throw new SlimeConfigError(report.problems.length > 0 ? report.problems : [UNSAFE_CREDENTIALS]);
}

function currentProvenance({ generator }: SlimeConfig, dictionary: Dictionary): HandlerProvenance {
  return {
    schemaHash: dictionary.schemaHash,
    dictionaryHash: dictionary.hash,
    promptHash: generator?.promptHash ?? LOCKED_MARKER,
    model: generator?.model ?? LOCKED_MARKER,
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
