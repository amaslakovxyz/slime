// Crystallize from a running instance: its connector, store, sandbox, limits and
// provenance, and its live run counts, so nothing is configured twice.
import { HANDLERS_NS, slimeInternals, type SlimeInternals } from '@slime-cloud/core/tooling';
import { SlimeError, type HandlerRecord, type Optimizer, type Slime, type SlimeStore, type StoreEntry } from '@slime-cloud/core';
import { checkCrystalFolder } from './check.js';
import { crystallize, type CrystalReport } from './crystallize.js';
import { readManifest } from './manifest.js';
import { verifyCrystalFolder } from './verify.js';

export interface CrystallizerOptions {
  /** The Crystal folder in the app, for example './slime-crystal'. */
  dir: string;
  /** Omit to move Liquid code over unchanged, if it passes the allowlist. */
  optimizer?: Optimizer;
  /** Successful runs a Liquid handler needs before it is crystallized; defaults to the instance's tiers.crystalReadyRuns, the threshold of its crystalReady event. */
  minRuns?: number;
  optimizeTimeoutMs?: number;
}

export interface CrystallizeRun {
  /** Only these request keys; omit for every ready handler. Checked, so an endpoint can pass a request body's `keys` as it is. */
  keys?: readonly string[] | undefined;
  /** Check everything, write nothing. */
  isDryRun?: boolean;
}

export interface PruneOptions {
  /** How long a Crystal must have existed before its Liquid handler goes. */
  olderThanDays?: number;
  /** List what would go, delete nothing. */
  isDryRun?: boolean;
}

const READ_ONLY_VIEW = 'the crystallize job only reads the store';
// Long enough for a broken Crystal to show up while its Liquid handler can still answer instead.
export const DEFAULT_PRUNE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export class Crystallizer {
  readonly #slime: Slime;
  readonly #options: CrystallizerOptions;

  constructor(slime: Slime, options: CrystallizerOptions) {
    slimeInternals(slime); // fails now, not on the first run, for anything but an engine
    this.#slime = slime;
    this.#options = options;
  }

  /** Crystallizes the ready Liquid handlers; each one passes the equivalence test before it is written. */
  async run({ keys, isDryRun }: CrystallizeRun = {}): Promise<CrystalReport[]> {
    if (keys !== undefined && !(Array.isArray(keys) && keys.every((key) => typeof key === 'string'))) {
      throw new SlimeError('INVALID_REQUEST', '`keys` must be an array of handler keys.');
    }
    await this.#slime.flush();
    const internals = slimeInternals(this.#slime);
    const { connector, sources, apiSchemas, sqlSourceName, runner, limits } = internals;
    const { dir, optimizer, minRuns, optimizeTimeoutMs } = this.#options;
    return crystallize({
      connector,
      sources,
      apiSchemas,
      sqlSourceName,
      store: withLiveRecords(internals),
      dir,
      runner,
      limits,
      provenance: this.#slime.provenance(),
      ...(optimizer ? { optimizer } : {}),
      minRuns: minRuns ?? internals.tiers.crystalReadyRuns,
      ...(optimizeTimeoutMs === undefined ? {} : { optimizeTimeoutMs }),
      ...(keys ? { keys } : {}),
      ...(isDryRun ? { isDryRun } : {}),
    });
  }

  /**
   * Deletes Liquid handlers that have been Crystal for olderThanDays (from memory and the
   * store, through slime.evict). While a Crystal is in the folder it answers first, so its
   * Liquid handler only matters as the fallback when the Crystal stops fitting the data.
   * Returns the keys it deleted (or would delete).
   */
  async prune({ olderThanDays = DEFAULT_PRUNE_DAYS, isDryRun = false }: PruneOptions = {}): Promise<string[]> {
    const { entries } = await readManifest(this.#options.dir);
    const cutoff = Date.now() - olderThanDays * DAY_MS;
    const saved = new Set((await slimeInternals(this.#slime).store.list(HANDLERS_NS)).map(({ key }) => key));
    const keys = Object.entries(entries)
      .filter(([key, entry]) => saved.has(key) && Date.parse(entry.createdAt) <= cutoff)
      .map(([key]) => key);
    if (!isDryRun) for (const key of keys) await this.#slime.evict(key);
    return keys;
  }

  /** The folder's problems without a database; empty means it passes. */
  check(): Promise<string[]> {
    return checkCrystalFolder(this.#options.dir);
  }

  /** The folder's problems on this instance's sources: equivalence with each Liquid reference, and plan cost. */
  verify(): Promise<string[]> {
    const { connector, sources, apiSchemas, runner, limits } = slimeInternals(this.#slime);
    return verifyCrystalFolder(this.#options.dir, { connector, sources, apiSchemas, runner, limits });
  }
}

// The store with the in-memory records laid over it: after promotion, runs and fixtures grow only
// in memory. Of the two, the one with more runs wins: on a host with several instances, the
// store may hold a busier instance's count, synced there, and this instance must not lower it.
function withLiveRecords({ store, liveRecords }: SlimeInternals): SlimeStore {
  const live = (): Map<string, HandlerRecord> => new Map(liveRecords().map((record) => [record.key, record]));
  return {
    async get(ns, key) {
      const saved = await store.get(ns, key);
      return ns === HANDLERS_NS ? busier(live().get(key), saved) : saved;
    },
    async list(ns, prefix) {
      const saved = await store.list(ns, prefix);
      if (ns !== HANDLERS_NS) return saved;
      const records = live();
      return saved.map(({ key, value }): StoreEntry => ({ key, value: busier(records.get(key), value) }));
    },
    put: async () => Promise.reject(new Error(READ_ONLY_VIEW)),
    delete: async () => Promise.reject(new Error(READ_ONLY_VIEW)),
  };
}

function busier(live: HandlerRecord | undefined, saved: unknown): unknown {
  if (!live) return saved;
  const savedRuns = (saved as { runs?: unknown } | undefined)?.runs;
  return typeof savedRuns === 'number' && savedRuns > live.runs ? saved : live;
}
