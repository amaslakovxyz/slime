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
/** How many requests the stored feed keeps for the Requests log's pages. */
export const RETAINED_EVENTS = 500;
/** A page without a limit: what the Lifecycle board has always read. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/** An event with its id: the cursor for the page before or after it. */
export interface FeedEvent extends RequestEvent {
  id: string;
}

/** `before` lists older events than that id, `after` newer ones (the page just above it); never both. */
export interface PageQuery {
  limit?: number;
  before?: string;
  after?: string;
}

export interface FeedList {
  total: number;
  /** Newest first, at most the limit. */
  events: FeedEvent[];
  hasOlder: boolean;
  hasNewer: boolean;
}

/** What the routes need from a feed: record an answered request, list a page. */
export interface RequestFeed {
  record(meta: QueryMeta, route?: 'crystal'): void;
  list(query?: PageQuery): FeedList | Promise<FeedList>;
}

/** An entry newest first, keyed by its id; ids sort by time. */
export interface FeedEntry {
  key: string;
  value: unknown;
}

export interface FeedPage {
  entries: FeedEntry[];
  hasOlder: boolean;
  hasNewer: boolean;
}

/** A store that reads one page by key range itself (DynamoDB: one Query), instead of list() + sort. */
export interface PagedStore {
  page(ns: string, query: Required<Pick<PageQuery, 'limit'>> & Omit<PageQuery, 'limit'>): Promise<FeedPage>;
}

/** One page of entries already sorted newest first; used where the whole feed is at hand. */
export function pageOf(newestFirst: readonly FeedEntry[], { limit = DEFAULT_PAGE_LIMIT, before, after }: PageQuery = {}): FeedPage {
  if (after !== undefined) {
    const newer = newestFirst.filter(({ key }) => key > after);
    return { entries: newer.slice(-limit), hasNewer: newer.length > limit, hasOlder: newestFirst.some(({ key }) => key <= after) };
  }
  const older = before === undefined ? [...newestFirst] : newestFirst.filter(({ key }) => key < before);
  return { entries: older.slice(0, limit), hasOlder: older.length > limit, hasNewer: before !== undefined && newestFirst.some(({ key }) => key >= before) };
}

/** The ISO time first, so ids sort by time; a per-process counter orders one millisecond, a random suffix keeps instances apart. */
function eventId(at: string, seq: number): string {
  return `${at}-${(seq % 1e6).toString().padStart(6, '0')}-${Math.random().toString(36).slice(2, 8)}`;
}

function toFeedList(page: FeedPage, total: number): FeedList {
  return { total, events: page.entries.map(({ key, value }) => ({ ...(value as RequestEvent), id: key })), hasOlder: page.hasOlder, hasNewer: page.hasNewer };
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
  readonly #events: FeedEntry[] = [];
  #total = 0;
  #seq = 0;

  constructor(cap = DEFAULT_EVENT_CAP) {
    this.#cap = cap;
  }

  record(meta: QueryMeta, route?: 'crystal'): void {
    this.#total += 1;
    const event = toEvent(meta, route);
    this.#events.unshift({ key: eventId(event.at, this.#seq++), value: event });
    if (this.#events.length > this.#cap) this.#events.length = this.#cap;
  }

  list(query?: PageQuery): FeedList {
    return toFeedList(pageOf(this.#events, query), this.#total);
  }
}

export const EVENTS_NS = 'events';
/** Every this-many writes an instance trims the store back to the cap; until then it may hold a few more. */
export const DEFAULT_PRUNE_EVERY = 10;

export interface StoredRequestsOptions {
  store: SlimeStore;
  /** How many events the store keeps (RETAINED_EVENTS). */
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

  constructor({ store, cap = RETAINED_EVENTS, pruneEvery = DEFAULT_PRUNE_EVERY, total, log = (line) => console.error(JSON.stringify(line)) }: StoredRequestsOptions) {
    this.#store = store;
    this.#cap = cap;
    this.#pruneEvery = pruneEvery;
    if (total) this.#total = total;
    this.#log = log;
  }

  record(meta: QueryMeta, route?: 'crystal'): void {
    const event = toEvent(meta, route);
    this.#pending.push({ key: eventId(event.at, this.#seq++), event });
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

  async list(query: PageQuery = {}): Promise<FeedList> {
    try {
      const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
      const paged = isPagedStore(this.#store) ? this.#store : undefined;
      const [page, usage] = await Promise.all([
        paged ? paged.page(EVENTS_NS, { ...query, limit }) : this.#sortedKeys().then((all) => pageOf(all, { ...query, limit })),
        this.#total?.().catch(() => undefined),
      ]);
      // Without a usage count (no usage table, or unreadable), count what is stored.
      return toFeedList(page, usage ?? (await this.#store.list(EVENTS_NS)).length);
    } catch (error) {
      this.#log({ feed: 'list_failed', message: (error as Error).message });
      return { total: 0, events: [], hasOlder: false, hasNewer: false };
    }
  }

  /** Newest first. */
  async #sortedKeys(): Promise<FeedEntry[]> {
    return (await this.#store.list(EVENTS_NS)).sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  }
}

function isPagedStore(store: SlimeStore): store is SlimeStore & PagedStore {
  return typeof (store as Partial<PagedStore>).page === 'function';
}
