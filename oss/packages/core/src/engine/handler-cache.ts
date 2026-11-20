import type { SlimeMode } from '../config/options.js';
import { changedProvenance, type HandlerProvenance } from '../request/key.js';
import type { SlimeStore } from '../store/types.js';
import type { HandlerRecord, HandlerSummary, StoredTier } from './types.js';

export const HANDLERS_NS = 'handlers';

export interface HandlerCacheSettings {
  store: SlimeStore;
  mode: SlimeMode;
  provenance: HandlerProvenance;
  gasWindowMs: number;
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

    const saved = (await this.#settings.store.get(HANDLERS_NS, key)) as HandlerRecord | undefined;
    if (!saved || !this.#isUsable(saved)) return undefined;
    this.#handlers.set(key, { record: saved, expiresAt: Number.POSITIVE_INFINITY });
    return saved;
  }

  addGas(record: HandlerRecord): void {
    this.#handlers.set(record.key, { record, expiresAt: Date.now() + this.#settings.gasWindowMs });
  }

  async evict(key: string): Promise<boolean> {
    const wasCached = this.#handlers.delete(key);
    const wasSaved = (await this.#settings.store.get(HANDLERS_NS, key)) !== undefined;
    if (wasSaved) await this.#settings.store.delete(HANDLERS_NS, key);
    return wasCached || wasSaved;
  }

  summaries(): HandlerSummary[] {
    return this.#liveRecords().map(({ key, intent, tier, runs, createdAt }) => ({ key, intent, tier, runs, createdAt }));
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

  // Locked mode can't regenerate, so it serves what it has (§4.7).
  #isUsable(saved: HandlerRecord): boolean {
    return this.#settings.mode === 'locked' || changedProvenance(saved.provenance, this.#settings.provenance).length === 0;
  }
}
