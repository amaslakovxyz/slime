# src

## Overview

The sources of `@slime-cloud/core`, compiled into `dist/` by
`tsconfig.build.json`. As of M1 there is no engine yet. `createSlime()` and
`slime.query()` arrive with M2 (`index.ts` comment, PLAN.md §7).

The files directly in this folder hold the package's public surface:
- the contracts (Ports) that apps implement;
- `SlimeConfig`, which an app builds and passes to Slime;
- the errors a caller sees;
- the single public entry, `index.ts`.

The subfolders hold pure building blocks that the engine will use.

## Interface

**Public entry: `index.ts`.** Everything an app may import is re-exported
here. Deep imports are not part of the API (`package.json` `exports` only has
`.`). A test pins the value exports.

- **Values:** `SlimeConfig`, `DEFAULT_TIERS`, `DEFAULT_LIMITS`, `SlimeError`
  and `SlimeConfigError`.
- **Types:**
  - from `config.ts`: `SlimeOptions`, `TierOptions`, `LimitOptions`,
    `SlimeEvent`, `CrystalRegistry`;
  - `ErrorCode`;
  - every interface in `ports.ts`;
  - `SlimeRequest`, `InputScalar` and `InputValue` (`request/parse.ts`),
    `ParamType` (`request/params.ts`) and `Shape` (`request/shape.ts`);
  - `BuiltInStore`, `SlimeStore`, `StoreEntry` and `StoreOption`
    (`store/types.ts`).

**`config.ts`**

- `SlimeConfig`: `constructor(options: SlimeOptions)` and
  `with(overrides): SlimeConfig`.
  - Its read-only fields are `connector`, `generator`, `reviewer`, `store`,
    `crystal`, `glossary`, `rules`, `tiers`, `limits`, `onEvent` and `mode`
    (`'explore' | 'locked'`).
- `SlimeOptions`:
  - `connector` (required);
  - `generator?` and `reviewer?`;
  - `store?: StoreOption`;
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

**`errors.ts`**

- `ErrorCode`: 14 codes, from `INVALID_REQUEST` to `EXECUTION_TIMEOUT`.
- `SlimeError(code, message, retryable = false, details?)`:
  - `status` comes from the internal `STATUS` map;
  - `toJSON()` returns `{ ...details, code, message, retryable }`.
- `SlimeConfigError(problems)`: `problems: readonly string[]`.

**`ports.ts`** (types only)

| Port | Methods |
|---|---|
| `Connector` | `name`, `describe()`, `check(sql, params)`, `run(sql, params)`, `safetyCheck()`, `close()` |
| `Generator` | `model`, `promptHash`, `generate(req, { timeoutMs, signal? })` |
| `Reviewer` | `model`, `review(req, { timeoutMs, signal? })` |
| `SandboxRunner` | `run(code, rows, input, limits)`, `close()` |

Supporting types: `SchemaInfo`, `TableInfo`, `ColumnInfo` (with
`values?: string[]` for enum-like columns), `RunResult`, `SafetyReport`,
`Artifact`, `GenerationRequest`, `GenerationResult`, `ReviewRequest`,
`ReviewResult` and `SandboxLimits`.

**Subfolders** (internal: only the types listed above are re-exported):

- [request/](./request/README.md): parsing of `{ intent, input?, output }`,
  the output notation, per-handler parameter types, and the cache keys
  (`requestKey`, `scopeKey`, `handlerKey`).
- [checks/](./checks/README.md): static SQL checks on generated code
  (`assertReadOnlySql`, `lintArtifact`).
- [store/](./store/README.md): the key-value `SlimeStore` Port and the
  built-in store options. It holds no implementation yet.

## Invariants

- **One check, every problem.** `SlimeConfig` validates before anything is
  stored and throws one `SlimeConfigError` listing every problem
  (`config.ts:validate`).
- **The options must be a plain object** (prototype `Object.prototype` or
  `null`). Otherwise that is the only problem reported.
- **Unknown options are refused:**
  - top-level keys outside `OPTION_KEYS`;
  - sub-keys of `tiers` and `limits` (`validateNumbers`).
- **`connector` is required** and must have `describe`, `check`, `run`,
  `safetyCheck` and `close`.
- **`generator`, when set,** needs `generate` plus non-empty `model` and
  `promptHash` strings.
- **`reviewer`, when set,** needs `review` and `model`. A reviewer without a
  generator is an error.
- **Numbers are checked against minimums.** `tiers` and `limits` values must
  be integers at or above `TIER_MIN` and `LIMIT_MIN`. The one exception is
  `limits.maxQueryCost`, which may be fractional.
- **Store options** (`validateStore`):
  - a store without `type` is a custom `SlimeStore` (`isCustomStore`) and
    must have `get`, `put`, `list` and `delete`;
  - `file` needs `dir`, and `postgres` needs `url`;
  - `postgres.table`, when given, must match `TABLE_NAME`;
  - `dynamodb` needs `table`, and `keys`, when given, must be
    `{ partition, sort }` strings;
  - every string field (`dir`, `url`, `table`, `region`, `prefix`) must be
    a non-empty string when given.
- **`crystal`** must be `undefined`, `false` or a plain object.
- **`glossary`** must be a plain object whose keys and values are non-empty
  strings.
- **`rules`** must be an array of non-empty strings.
- **`onEvent`**, when set, must be a function.
- **Mode comes from the generator:** `mode` is `'explore'` when a generator
  is set and `'locked'` otherwise (C6).
- **Immutable.** The config instance is frozen. `glossary`, `rules`, `tiers`,
  `limits`, `crystal` and built-in store options are frozen copies. Custom
  stores, the connector, the generator, the reviewer and `onEvent` are kept
  as given.
- **`with()` revalidates.** It rebuilds from the original options, merging
  `tiers` and `limits` key by key and dropping keys set to `undefined`, then
  validates again.
- **HTTP status is fixed per code.** `SlimeError.status` always comes from
  `STATUS[code]`, and in `toJSON()` the fields `code`, `message` and
  `retryable` override any `details` with the same names.

## Side Effects

- None.
- No file here reads `process.env` or `.env`, does I/O, or keeps mutable
  module state.
- `DEFAULT_TIERS` and `DEFAULT_LIMITS` are frozen constants created at load
  time.
- `onEvent` is stored but not called yet (no engine before M2).

## Verification

- Run: `npm test -w @slime-cloud/core` (from the repository root)
