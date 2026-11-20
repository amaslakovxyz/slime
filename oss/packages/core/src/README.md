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
  - from `config.ts`: `SlimeOptions`, `SlimeOptionOverrides`, `TierOptions`,
    `LimitOptions`, `SlimeMode`, `CrystalRegistry`, `SlimeEvent` and its five
    event interfaces;
  - `ErrorCode`, `SlimeErrorOptions` and `SlimeErrorBody`;
  - every interface in `ports.ts`;
  - `SlimeRequest`, `InputScalar`, `InputValue` and `InputValues`
    (`request/parse.ts`), `ParamType` (`request/params.ts`), `Shape` and
    `ObjectShape` (`request/shape.ts`);
  - `SlimeStore` and `StoreEntry` (`store/types.ts`).

**`config.ts`**: the `SlimeConfig` class. Its option types, defaults and
validation live in [config/](./config/README.md); `config.ts` re-exports
them.

**`guards.ts`**: `isPlainObject` and `isNonEmptyString`, shared by
`config/` and `request/`.

**`errors.ts`**

- `ErrorCode`: 14 codes, from `INVALID_REQUEST` to `EXECUTION_TIMEOUT`.
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

- None.
- No file here reads `process.env` or `.env`, does I/O, or keeps mutable
  module state.
- `DEFAULT_TIERS` and `DEFAULT_LIMITS` are frozen constants created at load
  time.
- `onEvent` is stored but not called yet (no engine before M2).

## Verification

- Run: `npm test -w @slime-cloud/core` (from the repository root)
