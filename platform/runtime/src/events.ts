// The last answered requests of this process, for the admin's live feed.
// Memory only: no input values or rows, just which handler answered and how.
import type { QueryMeta } from '@slime-cloud/core';

export interface RequestEvent {
  at: string;
  handlerKey: string;
  tier: QueryMeta['tier'];
  cache: QueryMeta['cache'];
  ms: number;
  /** Set when the request came through a Crystal's own route (`/v0/e/<key>`). */
  route?: 'crystal';
}

export const DEFAULT_EVENT_CAP = 50;

export class RecentRequests {
  readonly #cap: number;
  readonly #events: RequestEvent[] = [];
  #total = 0;

  constructor(cap = DEFAULT_EVENT_CAP) {
    this.#cap = cap;
  }

  record(meta: QueryMeta, route?: 'crystal'): void {
    this.#total += 1;
    this.#events.unshift({
      at: new Date().toISOString(),
      handlerKey: meta.handlerKey,
      tier: meta.tier,
      cache: meta.cache,
      ms: meta.timingsMs.total,
      ...(route ? { route } : {}),
    });
    if (this.#events.length > this.#cap) this.#events.length = this.#cap;
  }

  /** Newest first. */
  list(): { total: number; events: RequestEvent[] } {
    return { total: this.#total, events: [...this.#events] };
  }
}
