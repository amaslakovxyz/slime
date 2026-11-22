// The last answered requests, for the admin's live feed (Lifecycle board and Requests log).
// No input values or rows, just which handler answered and how.
//
// RecentRequests keeps them in this process's memory. StoredRequests keeps them in the
// endpoint's store, so every instance serves the same feed: the cloud runtime is one
// Lambda with several warm instances, and a per-process feed made each admin poll show
// whichever instance answered it (0 on a fresh one, another count on the next poll).
import type { QueryMeta, SlimeStore } from '@slime-cloud/core';

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

export interface FeedList {
  total: number;
  /** Newest first, at most the cap. */
  events: RequestEvent[];
}

/** What the routes need from a feed: record an answered request, list the newest. */
export interface RequestFeed {
  record(meta: QueryMeta, route?: 'crystal'): void;
  list(): FeedList | Promise<FeedList>;
}

function toEvent(meta: QueryMeta, route?: 'crystal'): RequestEvent {
  return {
    at: new Date().toISOString(),
    handlerKey: meta.handlerKey,
    tier: meta.tier,
    cache: meta.cache,
    ms: meta.timingsMs.total,
    ...(route ? { route } : {}),
  };
}

export class RecentRequests implements RequestFeed {
  readonly #cap: number;
  readonly #events: RequestEvent[] = [];
  #total = 0;

  constructor(cap = DEFAULT_EVENT_CAP) {
    this.#cap = cap;
  }

  record(meta: QueryMeta, route?: 'crystal'): void {
    this.#total += 1;
    this.#events.unshift(toEvent(meta, route));
    if (this.#events.length > this.#cap) this.#events.length = this.#cap;
  }

  /** Newest first. */
  list(): FeedList {
    return { total: this.#total, events: [...this.#events] };
  }
}

export const EVENTS_NS = 'events';
/** Every this-many writes an instance trims the store back to the cap; until then it may hold a few more. */
export const DEFAULT_PRUNE_EVERY = 10;

export interface StoredRequestsOptions {
  store: SlimeStore;
  cap?: number;
  pruneEvery?: number;
  /** The endpoint's request count across instances (usage counters); undefined falls back to the stored count. */
  total?: () => Promise<number | undefined>;
  log?: (line: Record<string, unknown>) => void;
}

/**
 * The feed in the endpoint's store (`events#<at>-<random>`), shared by every instance.
 * record() buffers; flush() writes, and runs with the other store writes before the response
 * goes out (Lambda freezes the process afterwards). A store failure is logged and dropped:
 * the feed must never fail a request.
 */
export class StoredRequests implements RequestFeed {
  readonly #store: SlimeStore;
  readonly #cap: number;
  readonly #pruneEvery: number;
  readonly #total?: () => Promise<number | undefined>;
  readonly #log: (line: Record<string, unknown>) => void;
  #pending: { key: string; event: RequestEvent }[] = [];
  #writesSincePrune = 0;
  #seq = 0;

  constructor({ store, cap = DEFAULT_EVENT_CAP, pruneEvery = DEFAULT_PRUNE_EVERY, total, log = (line) => console.error(JSON.stringify(line)) }: StoredRequestsOptions) {
    this.#store = store;
    this.#cap = cap;
    this.#pruneEvery = pruneEvery;
    if (total) this.#total = total;
    this.#log = log;
  }

  record(meta: QueryMeta, route?: 'crystal'): void {
    const event = toEvent(meta, route);
    // The ISO time first, so keys sort by time; a per-process counter orders events within one
    // millisecond, and a random suffix keeps two instances' keys apart.
    const seq = (this.#seq++ % 1e6).toString().padStart(6, '0');
    this.#pending.push({ key: `${event.at}-${seq}-${Math.random().toString(36).slice(2, 8)}`, event });
  }

  async flush(): Promise<void> {
    if (this.#pending.length === 0) return;
    const events = this.#pending;
    this.#pending = [];
    try {
      await Promise.all(events.map(({ key, event }) => this.#store.put(EVENTS_NS, key, event)));
      this.#writesSincePrune += events.length;
      if (this.#writesSincePrune >= this.#pruneEvery) {
        this.#writesSincePrune = 0;
        const stale = (await this.#sortedKeys()).slice(this.#cap);
        await Promise.all(stale.map(({ key }) => this.#store.delete(EVENTS_NS, key)));
      }
    } catch (error) {
      this.#log({ feed: 'flush_failed', message: (error as Error).message });
    }
  }

  async list(): Promise<FeedList> {
    try {
      const [entries, total] = await Promise.all([this.#sortedKeys(), this.#total?.().catch(() => undefined)]);
      return { total: total ?? entries.length, events: entries.slice(0, this.#cap).map(({ value }) => value as RequestEvent) };
    } catch (error) {
      this.#log({ feed: 'list_failed', message: (error as Error).message });
      return { total: 0, events: [] };
    }
  }

  /** Newest first. */
  async #sortedKeys() {
    return (await this.#store.list(EVENTS_NS)).sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  }
}
