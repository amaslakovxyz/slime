import type { SlimeStore, StoreEntry } from './types.js';

/** For tests. Values are kept as JSON text, so callers never share objects with the store. */
export function memoryStore(): SlimeStore {
  const namespaces = new Map<string, Map<string, string>>();
  const entriesOf = (ns: string): Map<string, string> => {
    const entries = namespaces.get(ns) ?? new Map<string, string>();
    namespaces.set(ns, entries);
    return entries;
  };

  return {
    async get(ns, key) {
      const json = entriesOf(ns).get(key);
      return json === undefined ? undefined : JSON.parse(json);
    },
    async put(ns, key, value) {
      entriesOf(ns).set(key, JSON.stringify(value));
    },
    async list(ns, prefix = ''): Promise<StoreEntry[]> {
      return [...entriesOf(ns)].filter(([key]) => key.startsWith(prefix)).map(([key, json]) => ({ key, value: JSON.parse(json) }));
    },
    async delete(ns, key) {
      entriesOf(ns).delete(key);
    },
  };
}
