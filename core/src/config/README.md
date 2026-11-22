# config

## Overview

The parts of `SlimeConfig` (PLAN.md C4): the option types, the defaults and
the validation. The class itself is in [`slime-config.ts`](./slime-config.ts), which
re-exports the types and defaults, so the public entry and tests import from
there.

- `options.ts`: `SlimeOptions`, `TierOptions`, `LimitOptions`, `SlimeMode`,
  `CrystalRegistry` and the `SlimeEvent` union with its five event interfaces.
- `defaults.ts`: `DEFAULT_TIERS`, `DEFAULT_LIMITS`, and the unit constants
  `HOUR_MS` and `MEBIBYTE`.
- `number-rules.ts`: the minimum per numeric option and which ones may be
  fractional; `numberProblems(section, settings)`.
- `validate.ts`: `configProblems(options)`, which returns every problem at
  once.

## Interface

- `SlimeConfig`: `constructor(options: SlimeOptions)` and
  `with(overrides): SlimeConfig`.
  - Its read-only fields are `connector`, `generator`, `reviewer`, `store`,
    `crystal`, `glossary`, `rules`, `tiers`, `limits` and `onEvent`.
- `SlimeOptions`:
  - `connector` (required);
  - `generator` (required);
  - `generator?` and `reviewer?`;
  - `store?: SlimeStore` (omitted: `createSlime()` builds the default file
    store in `./.slime`, M2);
  - `crystal?: CrystalRegistry | false`;
  - `glossary?: Record<string, string>` and `rules?: string[]`;
  - `tiers?: Partial<TierOptions>` and `limits?: Partial<LimitOptions>`;
  - `onEvent?: (event: SlimeEvent) => void`.
- `DEFAULT_TIERS`, frozen:
  `{ gasToLiquidRuns: 3, gasWindowMs: 3600000, maxReviews: 2, fixturesPerHandler: 5 }`.
- `DEFAULT_LIMITS`, frozen:
  `{ maxRepairs: 1, generationBudgetMs: 25000, reviewTimeoutMs: 60000, maxConcurrentGenerations: 2, maxGenerationsPerHour: 200, statementTimeoutMs: 2000, rowCap: 1000, maxQueryCost: 1000000, shapeTimeoutMs: 200, shapeMemoryBytes: 33554432 }`.
- `CrystalRegistry` is `Readonly<Record<string, unknown>>` for now; its
  exact shape arrives with M5.

## Invariants

- **One check, every problem.** `SlimeConfig` validates before anything is
  stored and throws one `SlimeConfigError` listing every problem
  (`configProblems` in `validate.ts`).
- **The options must be a plain object** (prototype `Object.prototype` or
  `null`). Otherwise that is the only problem reported.
- **Unknown options are refused:**
  - top-level keys outside `OPTION_KEYS` (`validate.ts`);
  - sub-keys of `tiers` and `limits` (`numberProblems` in `number-rules.ts`).
- **`connector` is required** and must have `describe`, `check`, `run`,
  `safetyCheck` and `close`.
- **`generator`, when set,** needs `generate` plus non-empty `model` and
  `promptHash` strings.
- **`reviewer`, when set,** needs `review` and `model`. A reviewer without a
  generator is an error.
- **Numbers are checked against minimums.** `tiers` and `limits` values must
  be integers at or above `TIER_MINIMUMS` and `LIMIT_MINIMUMS`. The one exception is
  `limits.maxQueryCost`, which may be fractional.
- **`store`, when set,** is any object with `get`, `put`, `list` and
  `delete`. It is kept as given (not copied or frozen), because a store has
  behavior and state. There are no `{ type: ... }` store options (C14).
- **`crystal`** must be `undefined`, `false` or a plain object.
- **`glossary`** must be a plain object whose keys and values are non-empty
  strings.
- **`rules`** must be an array of non-empty strings.
- **`onEvent`**, when set, must be a function.
- **A generator is required.** Every request no saved or Crystal handler
  answers is generated; there is no serve-only mode.
- **Immutable.** The config instance is frozen. `glossary`, `rules`, `tiers`,
  `limits` and `crystal` are frozen copies. The store, the connector, the generator, the reviewer and `onEvent` are kept
  as given.
- **`with()` revalidates.** It rebuilds from the original options, merging
  `tiers` and `limits` key by key and dropping keys set to `undefined`, then
  validates again.

## Side Effects

- None. No file here reads `process.env` or `.env`, does I/O, or keeps
  mutable module state. `DEFAULT_TIERS` and `DEFAULT_LIMITS` are frozen.

## Verification

- Run from the repository root: `npm test -w @slime-cloud/core`
- Tests: `test/config/config.test.ts`.
