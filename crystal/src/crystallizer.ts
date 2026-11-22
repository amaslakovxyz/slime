// Crystallize from a running instance: its connector, store, sandbox, limits and
// provenance, and its live run counts, so nothing is configured twice.
import { HANDLERS_NS, slimeInternals, type SlimeInternals } from '@slime-cloud/core/tooling';
import type { HandlerRecord, Optimizer, Slime, SlimeStore, StoreEntry } from '@slime-cloud/core';
import { checkCrystalFolder } from './check.js';
import { crystallize, type CrystalReport } from './crystallize.js';
import { verifyCrystalFolder } from './verify.js';

export interface CrystallizerOptions {
  /** The Crystal folder in the app, for example './slime-crystal'. */
  dir: string;
  /** Omit to move Liquid code over unchanged, if it passes the allowlist. */
  optimizer?: Optimizer;
  /** Successful runs a Liquid handler needs before it is crystallized. */
  minRuns?: number;
  optimizeTimeoutMs?: number;
}

export interface CrystallizeRun {
  /** Only these request keys; omit for every ready handler. */
  keys?: readonly string[];
  /** Check everything, write nothing. */
  isDryRun?: boolean;
}

const READ_ONLY_VIEW = 'the crystallize job only reads the store';

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
    await this.#slime.flush();
    const internals = slimeInternals(this.#slime);
    const { connector, runner, limits } = internals;
    const { dir, optimizer, minRuns, optimizeTimeoutMs } = this.#options;
    return crystallize({
      connector,
      store: withLiveRecords(internals),
      dir,
      runner,
      limits,
      provenance: this.#slime.provenance(),
      ...(optimizer ? { optimizer } : {}),
      ...(minRuns === undefined ? {} : { minRuns }),
      ...(optimizeTimeoutMs === undefined ? {} : { optimizeTimeoutMs }),
      ...(keys ? { keys } : {}),
      ...(isDryRun ? { isDryRun } : {}),
    });
  }

  /** The folder's problems without a database; empty means it passes. */
  check(): Promise<string[]> {
    return checkCrystalFolder(this.#options.dir);
  }

  /** The folder's problems on this instance's database: equivalence with each Liquid reference, and plan cost. */
  verify(): Promise<string[]> {
    const { connector, runner, limits } = slimeInternals(this.#slime);
    return verifyCrystalFolder(this.#options.dir, { connector, runner, limits });
  }
}

// The store with the in-memory records laid over it: after promotion, runs and fixtures grow only in memory.
function withLiveRecords({ store, liveRecords }: SlimeInternals): SlimeStore {
  const live = (): Map<string, HandlerRecord> => new Map(liveRecords().map((record) => [record.key, record]));
  return {
    async get(ns, key) {
      return (ns === HANDLERS_NS ? live().get(key) : undefined) ?? (await store.get(ns, key));
    },
    async list(ns, prefix) {
      const saved = await store.list(ns, prefix);
      if (ns !== HANDLERS_NS) return saved;
      const records = live();
      return saved.map(({ key, value }): StoreEntry => ({ key, value: records.get(key) ?? value }));
    },
    put: async () => Promise.reject(new Error(READ_ONLY_VIEW)),
    delete: async () => Promise.reject(new Error(READ_ONLY_VIEW)),
  };
}
