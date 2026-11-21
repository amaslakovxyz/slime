// The core saves a handler once, when it turns Liquid; later runs only count in
// memory, while crystallize() reads runs from the store. These helpers copy the
// live counts into the store, never lowering a saved count. Used before every
// Crystallize, throttled on each flush, and when an endpoint's engine closes:
// on shutdown locally, and on eviction or replacement in the Lambda tenant cache.
import type { SlimeStore } from '@slime-cloud/core';

const HANDLERS_NS = 'handlers';

export async function syncLiveRuns(store: SlimeStore, live: readonly { key: string; runs: number }[], keys?: readonly string[]): Promise<void> {
  const wanted = keys ? new Set(keys) : undefined;
  for (const { key, runs } of live) {
    if (wanted && !wanted.has(key)) continue;
    const saved = (await store.get(HANDLERS_NS, key)) as { runs?: number } | undefined;
    if (saved && typeof saved.runs === 'number' && runs > saved.runs) await store.put(HANDLERS_NS, key, { ...saved, runs });
  }
}

export const DEFAULT_RUNS_SYNC_MS = 60_000;

/**
 * At most one sync per interval per process, Liquid handlers only, and only the
 * ones whose live count grew since this process last wrote it (so an idle handler
 * costs no store call). The Lambda sets the interval to 0: Crystallize may land on
 * another warm instance, which sees only what the store holds. Each instance
 * counts its own runs, so the saved count is the busiest instance's, not the sum:
 * it under-counts when traffic spreads over several warm instances (a core fix
 * with an atomic increment removes that).
 */
export class LiveRunsSync {
  #last = 0;
  /** Key -> the live count this process last wrote. */
  readonly #written = new Map<string, number>();

  constructor(
    private readonly store: SlimeStore,
    private readonly live: () => readonly { key: string; tier: string; runs: number }[],
    private readonly intervalMs = DEFAULT_RUNS_SYNC_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async maybeSync(): Promise<boolean> {
    if (this.now() - this.#last < this.intervalMs) return false;
    this.#last = this.now();
    const grown = this.live().filter((h) => h.tier === 'liquid' && h.runs > (this.#written.get(h.key) ?? 0));
    if (grown.length === 0) return false;
    await syncLiveRuns(this.store, grown);
    for (const { key, runs } of grown) this.#written.set(key, runs);
    return true;
  }
}
