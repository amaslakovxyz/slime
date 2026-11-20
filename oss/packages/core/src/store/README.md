# store

## Overview

The contract for where Slime keeps its own state: Liquid handlers with their
fixtures, and run counts (see `PLAN.md` C13, C14 and §4.7 in
[`../../PLAN.md`](../../PLAN.md)). The contract is a small key-value Port, so
mapping any backend onto it takes four calls.

This directory holds only the contract, in `types.ts`. Core will ship two
stores, `fileStore(dir)` (the default, `./.slime`) and `memoryStore()`, in
M2. Any other backend (Postgres, DynamoDB, Redis) is a custom `SlimeStore`
the app passes in; Slime Cloud brings its own (M7).

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

Public package exports, from [`../index.ts`](../index.ts): the types
`SlimeStore` and `StoreEntry`.

Consumers: [`../config.ts`](../config.ts) types the `store` option as
`SlimeStore` and checks that it has `get`, `put`, `list` and `delete`.

## Invariants

- The `store` option is always an object implementing `SlimeStore`; there are
  no `{ type: ... }` store options. When it is omitted, `SlimeConfig.store` is
  `undefined` and `createSlime()` builds the default file store (M2).
- A store is used as given, not copied or frozen: it has behavior and state.
- Handlers live in the `handlers` namespace, keyed by the request key alone
  (§4.7). What a handler was generated against (its provenance) is stored
  inside the value, not in the key.
- Values must be JSON-serializable.
- Core v1 assumes one writer per store. Several writers need a custom store
  that handles them (§4.7, §8).

## Side Effects

- None. `types.ts` declares types only and has no I/O.
- Implementations of the `SlimeStore` contract are expected to do I/O against
  their backend. None exist in this directory yet.

## Verification

- Run from the repository root: `npm test -w @slime-cloud/core`
- `test/config.test.ts` imports only the `SlimeStore` type from this
  directory. Its `store option (C14, §4.7)` suite covers store validation
  through `SlimeConfig`.
