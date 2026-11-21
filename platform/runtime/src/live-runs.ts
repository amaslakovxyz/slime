// The core saves a handler once, when it turns Liquid; later runs only count in
// memory, while crystallize() reads runs from the store. These helpers copy the
// live counts into the store, never lowering a saved count. Used by the local
// entry before Crystallize and, throttled, by the Lambda entry on flush.
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
 * At most one sync per interval per process, Liquid handlers only. Each Lambda
 * instance counts its own runs, so the saved count is the busiest instance's,
 * not the sum: it under-counts with several warm instances (a core fix with an
 * atomic increment removes that).
 */
export class LiveRunsSync {
  #last = 0;

  constructor(
    private readonly store: SlimeStore,
    private readonly live: () => readonly { key: string; tier: string; runs: number }[],
    private readonly intervalMs = DEFAULT_RUNS_SYNC_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async maybeSync(): Promise<boolean> {
    if (this.now() - this.#last < this.intervalMs) return false;
    this.#last = this.now();
    await syncLiveRuns(this.store, this.live().filter((h) => h.tier === 'liquid'));
    return true;
  }
}
