# store

## Overview

The contract for where Slime keeps its own state: handlers, run counts, and
the dictionary (see `PLAN.md` C13, C14 and §4.8 in
[`../../PLAN.md`](../../PLAN.md)). The contract is a small key-value Port, so
mapping any backend onto it takes four calls.

This directory holds only the contract, in `types.ts`. No store
implementation (file, memory, Postgres or DynamoDB) exists in the code yet.
The built-in types are config shapes that
[`../config.ts`](../config.ts) validates; nothing else uses them yet.

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
- `type BuiltInStore`: the built-in stores, selected by `type` in
  `SlimeConfig`:
  - `{ type: 'file'; dir: string }`
  - `{ type: 'memory' }`
  - `{ type: 'postgres'; url: string; table?: string }`
  - `{ type: 'dynamodb'; table: string; region?: string; prefix?: string; keys?: { partition: string; sort: string } }`.
    The doc comments give `prefix` (the partition key value) a default of
    `"default"` and `keys` a default of `{ partition: 'pk', sort: 'sk' }`.
    No code applies these defaults yet; the DynamoDB store (M3) must use
    exactly these.
- `type StoreOption = BuiltInStore | SlimeStore`: the type of the `store`
  option in `SlimeConfig`.
- `const DEFAULT_STORE: BuiltInStore`: a frozen `{ type: 'file', dir: './.slime' }`.
- `function isCustomStore(store: StoreOption): store is SlimeStore`: returns
  `true` when `store` has no `type` property.

Public package exports, from [`../index.ts`](../index.ts): only the types
`BuiltInStore`, `SlimeStore`, `StoreEntry` and `StoreOption`. The package
entry point does not export `DEFAULT_STORE` or `isCustomStore`.

Consumers: [`../config.ts`](../config.ts) imports `DEFAULT_STORE`,
`isCustomStore` and `StoreOption`. It uses `DEFAULT_STORE` when the `store`
option is missing and validates the shape in `validateStore`.

## Invariants

- A `type` property marks an option as a built-in store. An option without
  one is a custom `SlimeStore`. The `type` key is reserved: a custom store
  must not define one. `isCustomStore` is the only place this rule lives;
  `config.ts` calls it in `validateStore` and `freezeStore`.
- A custom store must implement `get`, `put`, `list` and `delete`.
  `validateStore` in `config.ts` reports any missing method. `init` and
  `close` are optional.
- Callers must not mutate `DEFAULT_STORE`: it is frozen with `Object.freeze`.
- Values must be JSON-serializable and stay under 300 KB, so that every
  backend, DynamoDB included, can hold them. This limit is stated in the
  `types.ts` header comment. No code enforces it yet.
- `config.ts` (`validateStore`, `STORE_TYPES`) validates each built-in type:
  - `file` requires `dir`.
  - `postgres` requires `url`. An optional `table` must be a lowercase
    identifier.
  - `dynamodb` requires `table`. An optional `keys` must contain string
    `partition` and `sort` values.
  - Any other `type` value is rejected.

## Side Effects

- None. `types.ts` declares types and one frozen constant and has no I/O.
- Implementations of the `SlimeStore` contract are expected to do I/O against
  their backend (disk, Postgres or DynamoDB). None exist in this directory yet.

## Verification

- Run from the repository root: `npm test -w @slime-cloud/core`
- `test/config.test.ts` imports only the `SlimeStore` type from this
  directory. Its `store option (C14, §4.8)` suite covers store option
  validation through `SlimeConfig`.
