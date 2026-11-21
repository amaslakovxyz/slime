# store

## Overview

The contract for where Slime keeps its own state: Liquid handlers with their
fixtures, and run counts (see `PLAN.md` C13, C14 and §4.7 in
[`../../PLAN.md`](../../PLAN.md)). The contract is a small key-value Port, so
mapping any backend onto it takes four calls.

`types.ts` holds the contract. Core ships two stores with no extra packages:
`fileStore(dir = './.slime')` (`file-store.ts`, the default) and
`memoryStore()` (`memory-store.ts`, for tests). Any other backend (Postgres,
DynamoDB, Redis) is a custom `SlimeStore` the app passes in; Slime Cloud
brings its own (M7).

## Interface

From `types.ts`:

- `interface StoreEntry { key: string; value: unknown }`: one entry returned by
  `SlimeStore.list`.
- `interface SlimeStore`: the key-value Port.
  - `init?(): Promise<void>`: optional. Prepares the backend, for example by
    creating a table or checking that one exists.
  - `get(ns, key): Promise<unknown | undefined>`
  - `put(ns, key, value): Promise<void>`
  - `list(ns, prefix?): Promise<StoreEntry[]>`: every entry in `ns` whose key
    starts with `prefix`, or every entry in `ns` when `prefix` is omitted.
  - `delete(ns, key): Promise<void>`
  - `close?(): Promise<void>`: optional. Releases connections.

- `fileStore(dir?)`: one JSON file per key, `<dir>/<ns>/<key>.json`.
  Writes go to a temporary file and are renamed into place. Namespaces and
  keys must be safe file names (`SAFE_NAME`); anything else throws.
- `memoryStore()`: keeps JSON text per key, so a value read back is always a
  copy.

Public package exports, from [`../index.ts`](../index.ts): `fileStore`,
`memoryStore`, `DEFAULT_STORE_DIR` and the types `SlimeStore` and
`StoreEntry`.

Consumers: [`../config/options.ts`](../config/options.ts) types the `store` option as
`SlimeStore` and checks that it has `get`, `put`, `list` and `delete`.

## Invariants

- The `store` option is always an object implementing `SlimeStore`; there are
  no `{ type: ... }` store options. When it is omitted, `SlimeConfig.store` is
  `undefined` and `createSlime()` builds the default file store.
- A store is used as given, not copied or frozen: it has behavior and state.
- Handlers live in the `handlers` namespace, keyed by the request key alone
  (§4.7). What a handler was generated against (its provenance) is stored
  inside the value, not in the key.
- Values must be JSON-serializable.
- Core v1 assumes one writer per store. Several writers need a custom store
  that handles them (§4.7, §8).

## Side Effects

- `file-store.ts` reads and writes files under its directory; it creates
  namespace folders on the first write.
- `memory-store.ts` and `types.ts` do no I/O.

## Verification

- Run from the repository root: `npm test -w @slime-cloud/core`
- `src/testing/store-contract.ts` is the `SlimeStore` contract;
  `test/stores/stores.test.ts` runs it against both stores and adds the file
  store's own rules. `test/config/config.test.ts` covers the `store` option.
