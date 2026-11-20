// Where Slime keeps its own state: Liquid handlers with their fixtures, and
// run counts (PLAN.md C13, C14, §4.7). A small key-value contract, so any
// backend is a mapping to four calls. Values are JSON-serializable.
//
// The store option in SlimeConfig is always an object implementing this
// interface. Core ships fileStore() and memoryStore() (M2); any other backend
// (Postgres, DynamoDB, Redis) is a custom store the app passes in.

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
