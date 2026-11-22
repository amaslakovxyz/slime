import type { SlimeMode } from '../config/options.js';
import { fromStoredArtifact, type Artifact, type LegacyArtifact } from '../models/artifact.js';
import { changedProvenance, type HandlerProvenance } from '../request/key.js';
import { SlimeError } from '../shared/errors.js';
import type { SlimeStore } from '../stores/types.js';
import type { HandlerRecord, HandlerSummary, StoredTier } from './types.js';

export const HANDLERS_NS = 'handlers';

/** A record as a store returns it: older ones hold the single-query artifact. */
type StoredRecord = Omit<HandlerRecord, 'artifact'> & { artifact: Artifact | LegacyArtifact };

/** Every read of a saved handler goes through here, so nothing past the store sees the legacy form. */
export function recordFromStore(value: unknown, sqlSourceName: string): HandlerRecord {
  const stored = value as StoredRecord;
  return { ...stored, artifact: fromStoredArtifact(stored.artifact, sqlSourceName) };
}

export interface HandlerCacheSettings {
  store: SlimeStore;
  mode: SlimeMode;
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

  countByTier(): Record<StoredTier, number> {
    const counts: Record<StoredTier, number> = { gas: 0, liquid: 0 };
    for (const record of this.#liveRecords()) counts[record.tier]++;
    return counts;
  }

  #liveRecords(): HandlerRecord[] {
    const now = Date.now();
    return [...this.#handlers.values()].filter(({ expiresAt }) => expiresAt > now).map(({ record }) => record);
  }

  // Explore mode regenerates an unfit handler; locked mode can't, so it says why instead of serving it (MS14).
  #fitsSources(saved: HandlerRecord): boolean {
    const problem = this.#settings.savedHandlerProblem?.(saved);
    if (problem === undefined) return true;
    if (this.#settings.mode === 'explore') return false;
    throw new SlimeError('HANDLER_NOT_FOUND', `The saved handler no longer fits the configured sources: ${problem}`);
  }

  // Locked mode can't regenerate, so it serves what it has (§4.7).
  #isUsable(saved: HandlerRecord): boolean {
    return this.#settings.mode === 'locked' || changedProvenance(saved.provenance, this.#settings.provenance).length === 0;
  }
}
