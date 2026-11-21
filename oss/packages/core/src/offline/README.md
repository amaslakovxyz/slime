# offline

## Overview

The `@slime-cloud/core/offline` entry (PLAN.md C7): a `Generator` that serves
hand-written handlers instead of calling a model, so tests, CI and benchmarks
run without an API key.

## Interface

- `offlineGenerator(handlers: OfflineHandlers): Generator`
  (`offline-generator.ts`), where `OfflineHandlers` maps an intent to an
  `Artifact`.
  - `model` is `'offline'`;
  - `promptHash` is a hash of the handlers, so editing them regenerates
    handlers in explore mode.

## Invariants

- Intents match after the same normalization as cache keys (R3).
- An intent with no handler gets an `unsatisfiable` artifact, so the query
  fails with `INTENT_UNSATISFIABLE`.
- The main entry never imports this folder; `index.ts` here is the subpath's
  entry.

## Side Effects

- None.

## Verification

- `test/package.test.ts` pins the subpath and its exports. The built package
  is exercised by a smoke run of `createSlime()` with this generator.
