// Where Slime keeps its own state (C13, §4.7). Any backend is a mapping to four
// calls; core ships fileStore() and memoryStore() (M2), the rest are app stores.

export interface StoreEntry {
  key: string;
  value: unknown;
}

export interface SlimeStore {
  /** Optional: create or check a table. */
  init?(): Promise<void>;
  get(ns: string, key: string): Promise<unknown | undefined>;
  /** Values are JSON-serializable. */
  put(ns: string, key: string, value: unknown): Promise<void>;
  /** Entries whose key starts with `prefix`; all of `ns` when omitted. */
  list(ns: string, prefix?: string): Promise<StoreEntry[]>;
  delete(ns: string, key: string): Promise<void>;
  /** Optional: release connections. */
  close?(): Promise<void>;
}
