import { changedProvenance, type HandlerProvenance } from '../request/key.js';
import type { SlimeStore } from '../stores/types.js';
import type { HandlerSummary } from './types.js';
import { HANDLERS_NS, recordFromStore, type HandlerRecord, type StoredTier } from '../handler/record.js';

export interface HandlerCacheSettings {
  store: SlimeStore;
  provenance: HandlerProvenance;
  sqlSourceName: string;
  gasWindowMs: number;
  /** Why a saved handler can't be served with today's sources (MS14); undefined when it can. */
  savedHandlerProblem?: (record: HandlerRecord) => string | undefined;
}

interface CachedHandler {
  record: HandlerRecord;
  expiresAt: number;
}

/** Gas handlers live in memory until their window ends; saved handlers are read from the store on a miss (§4.7). */
export class HandlerCache {
  readonly #settings: HandlerCacheSettings;
  readonly #handlers = new Map<string, CachedHandler>();

  constructor(settings: HandlerCacheSettings) {
    this.#settings = settings;
  }

  async find(key: string): Promise<HandlerRecord | undefined> {
    const cached = this.#handlers.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.record;
    this.#handlers.delete(key);

    const value = await this.#settings.store.get(HANDLERS_NS, key);
    if (value === undefined) return undefined;
    const saved = recordFromStore(value, this.#settings.sqlSourceName);
    if (!this.#isUsable(saved) || !this.#fitsSources(saved)) return undefined;
    this.#handlers.set(key, { record: saved, expiresAt: Number.POSITIVE_INFINITY });
    return saved;
  }

  addGas(record: HandlerRecord): void {
    this.#handlers.set(record.key, { record, expiresAt: Date.now() + this.#settings.gasWindowMs });
  }

  /** A promoted handler stays in memory until evicted. */
  keep(key: string): void {
    const cached = this.#handlers.get(key);
    if (cached) cached.expiresAt = Number.POSITIVE_INFINITY;
  }

  async evict(key: string): Promise<boolean> {
    const wasCached = this.#handlers.delete(key);
    const wasSaved = (await this.#settings.store.get(HANDLERS_NS, key)) !== undefined;
    if (wasSaved) await this.#settings.store.delete(HANDLERS_NS, key);
    return wasCached || wasSaved;
  }

  summaries(): HandlerSummary[] {
    return this.#liveRecords().map(({ key, intent, tier, runs, createdAt, review }) => ({ key, intent, tier, runs, createdAt, review }));
  }

  /** The live records themselves (not copies): runs and fixtures as they are now. */
  records(): HandlerRecord[] {
    return this.#liveRecords();
  }

  countByTier(): Record<StoredTier, number> {
    const counts: Record<StoredTier, number> = { gas: 0, liquid: 0 };
    for (const record of this.#liveRecords()) counts[record.tier]++;
    return counts;
  }

  #liveRecords(): HandlerRecord[] {
    const now = Date.now();
    return [...this.#handlers.values()].filter(({ expiresAt }) => expiresAt > now).map(({ record }) => record);
  }

  // An unfit handler is a miss: it is generated again for today's sources (MS14).
  #fitsSources(saved: HandlerRecord): boolean {
    return this.#settings.savedHandlerProblem?.(saved) === undefined;
  }

  // A handler made with another schema, dictionary, prompt or model is generated again (§4.7).
  #isUsable(saved: HandlerRecord): boolean {
    return changedProvenance(saved.provenance, this.#settings.provenance).length === 0;
  }
}
