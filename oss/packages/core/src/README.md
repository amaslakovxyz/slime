# src

## Overview

The sources of `@slime-cloud/core`, compiled into `dist/` by
`tsconfig.build.json`. `createSlime()` (`create-slime.ts`) builds a Slime
instance from a `SlimeConfig`; the engine and its parts are in the
subfolders.

The files directly in this folder hold the package's public surface:
- the contracts (Ports) that apps implement;
- `SlimeConfig`, which an app builds and passes to Slime;
- the errors a caller sees;
- the single public entry, `index.ts`.

The subfolders hold the engine and its building blocks.

## Interface

**Public entry: `index.ts`.** Everything an app may import is re-exported
here. Deep imports are not part of the API (`package.json` `exports` only has
`.`). A test pins the value exports.

- **Values:** `createSlime`, `SlimeConfig`, `DEFAULT_TIERS`,
  `DEFAULT_LIMITS`, `SlimeError`, `SlimeConfigError`, `fileStore`,
  `memoryStore` and `DEFAULT_STORE_DIR`.
- **Types:**
  - from `config.ts`: `SlimeOptions`, `SlimeOptionOverrides`, `TierOptions`,
    `LimitOptions`, `SlimeMode`, `CrystalRegistry`, `SlimeEvent` and its five
    event interfaces;
  - `ErrorCode`, `SlimeErrorOptions` and `SlimeErrorBody`;
  - every interface in `ports.ts`;
  - `SlimeRequest`, `InputScalar`, `InputValue` and `InputValues`
    (`request/parse.ts`), `ParamType` (`request/params.ts`), `Shape` and
    `ObjectShape` (`request/shape.ts`);
  - `SlimeStore` and `StoreEntry` (`store/types.ts`);
  - the instance API from `engine/types.ts`: `Slime`, `QueryResult`,
    `QueryMeta`, `QueryTimings`, `HandlerRecord`, `HandlerSummary`,
    `SlimeStats`, `Tier`, `StoredTier`, `ReviewStatus`, `CacheOutcome`;
  - `HandlerProvenance` and `ParamTypes`.

**`create-slime.ts`**: `createSlime(config)`. Startup order: the
connector's safety check (an unsafe user throws `SlimeConfigError`),
`store.init()`, `describe()` and the dictionary. In locked mode it emits one
`warning` event when saved handlers were made against another schema.

**`config.ts`**: the `SlimeConfig` class. Its option types, defaults and
validation live in [config/](./config/README.md); `config.ts` re-exports
them.

**`guards.ts`**: `isPlainObject` and `isNonEmptyString`, shared by
`config/` and `request/`.

**`errors.ts`**

- `ErrorCode`: 13 codes, from `INVALID_REQUEST` to `EXECUTION_TIMEOUT`.
- `ErrorCode` is derived from the `STATUS_BY_CODE` map, so a code can't
  exist without a status.
- `SlimeError(code, message, { retryable = false, details }?)`:
  - `status` comes from `STATUS_BY_CODE`;
  - `toJSON()` returns a `SlimeErrorBody`: `{ ...details, code, message, retryable }`.
- `SlimeConfigError(problems)`: `problems: readonly string[]`.

**`ports.ts`** (types only)

| Port | Methods |
|---|---|
| `Connector` | `name`, `describe()`, `check(sql, params, limits)`, `run(sql, params, limits)`, `safetyCheck()`, `close()` |
| `Generator` | `model`, `promptHash`, `generate(request, options: ModelCallOptions)` |
| `Reviewer` | `model`, `review(request, options: ModelCallOptions)` |
| `SandboxRunner` | `run(job: ShapeJob, limits)`, `close()` |

Supporting types: `SchemaInfo`, `TableInfo`, `ColumnInfo` (with
`values?: string[]` for enum-like columns), `ForeignKey`, `RunResult`,
`SafetyReport`, `Artifact`, `GenerationRequest`, `GenerationResult`,
`ReviewRequest`, `ReviewResult` (both results extend `ModelUsage`),
`ParamTypesForModel`, `ModelCallOptions`, `SandboxLimits`, `ShapeJob`,
`QueryPlan` (`check` returns it; the engine compares `cost` with
`limits.maxQueryCost` itself) and `QueryLimits` (`{ timeoutMs, rowCap }`,
passed with each `check` and `run`). `SandboxRunner` is a type only: in v1 core
always uses its own QuickJS runner.

**Subfolders** (internal: only the types listed above are re-exported):

- [config/](./config/README.md): `SlimeConfig`'s option types, defaults and
  validation.
- [engine/](./engine/README.md): the Slime instance behind `createSlime()`.
- [shaping/](./shaping/README.md): the QuickJS shaping sandbox.
- [dictionary/](./dictionary/README.md): the dictionary text and hashes.
- [offline/](./offline/README.md): the offline generator (its own subpath).
- [request/](./request/README.md): parsing of `{ intent, input?, output }`,
  the output notation, per-handler parameter types, and the cache keys
  (`requestKey`) and handler provenance (`changedProvenance`).
- [checks/](./checks/README.md): static SQL checks on generated code
  (`assertReadOnlySql`, `lintArtifact`).
- [store/](./store/README.md): the key-value `SlimeStore` Port. It holds no
  implementation yet.

## Invariants

- **Config rules** (validation, defaults, immutability, `with()`) are listed
  in [config/README.md](./config/README.md).
- **HTTP status is fixed per code.** `SlimeError.status` always comes from
  `STATUS_BY_CODE[code]`, and in `toJSON()` the fields `code`, `message` and
  `retryable` override any `details` with the same names.

## Side Effects

- No file reads `process.env` or `.env`, and no module keeps mutable state:
  every cache, pool and counter belongs to one Slime instance.
- `createSlime()` calls the connector and the store. A query runs SQL through
  the connector and shaping code in worker threads (`shaping/`).
- `DEFAULT_TIERS` and `DEFAULT_LIMITS` are frozen constants created at load
  time.

## Verification

- Run: `npm test -w @slime-cloud/core` (from the repository root)
