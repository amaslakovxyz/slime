// Where Slime keeps its own state: handlers, run counts and the dictionary
// (PLAN.md C13, C14, §4.8). A small key-value contract, so any backend is a
// mapping to four calls. Values are JSON-serializable and stay under 300 KB,
// which every backend, DynamoDB included, can hold.

export interface StoreEntry {
  key: string;
  value: unknown;
}

export interface SlimeStore {
  /** Prepares the backend (creates a table, checks one exists). Optional. */
  init?(): Promise<void>;
  get(ns: string, key: string): Promise<unknown | undefined>;
  put(ns: string, key: string, value: unknown): Promise<void>;
  /** Every entry in `ns` whose key starts with `prefix` (all of them when omitted). */
  list(ns: string, prefix?: string): Promise<StoreEntry[]>;
  delete(ns: string, key: string): Promise<void>;
  /** Releases connections. Optional. */
  close?(): Promise<void>;
}

/** Built-in stores, chosen by `type` in SlimeConfig. */
export type BuiltInStore =
  | { type: 'file'; dir: string }
  | { type: 'memory' }
  | { type: 'postgres'; url: string; table?: string }
  | {
      type: 'dynamodb';
      table: string;
      region?: string;
      /** Partition key value: the tenant in Slime Cloud, a fixed value elsewhere. Default "default". */
      prefix?: string;
      /** Attribute names of the table's keys. Default { partition: 'pk', sort: 'sk' }. */
      keys?: { partition: string; sort: string };
    };

/** What the `store` option accepts: a built-in store by type, or any SlimeStore. */
export type StoreOption = BuiltInStore | SlimeStore;

export const DEFAULT_STORE: BuiltInStore = Object.freeze({ type: 'file', dir: './.slime' });

export function isCustomStore(store: StoreOption): store is SlimeStore {
  return !('type' in store);
}
