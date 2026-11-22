# src

## Overview

The sources of `@slime-cloud/core`, compiled into `dist/` by
`tsconfig.build.json`. `createSlime()` (`create-slime.ts`) builds a Slime
instance from a `SlimeConfig`.

The folders say what the system is made of:

| Kind | Folder | What it is |
|---|---|---|
| **Port** | [models/](./models/README.md) | Generator, Reviewer, Optimizer. `types.ts`, `ModelClient` + `claude/`, `groq/`. |
| **Port** | [sources/](./sources/README.md) | Where data comes from: one SQL source (`sql/`, `Connector` + `postgres/`) and any number of API sources (`api/`, `ApiSource` + `defineApiSource`, `notion/`). `lifecycle.ts` starts and closes them all. |
| **Port** | [stores/](./stores/README.md) | Slime's own key-value state. `types.ts` + file and memory stores. |
| **Port** | [sandbox/](./sandbox/README.md) | Where generated shaping code runs. `types.ts` + `quickjs/`. |
| Domain | [artifact/](./artifact/README.md) | What a model writes: `Artifact` (steps + `shapeJs`) and the model-free checks on it. |
| Domain | [handler/](./handler/README.md) | What Slime stores and serves: `HandlerRecord`, tiers, Crystal types, the fit-to-sources check. |
| Engine | [engine/](./engine/README.md) | The Slime instance: handler cache, generation, review, promotion; `crystal/` serves Crystal handlers. |
| Engine | [request/](./request/README.md) | Parsing `{ intent, input?, output }`, the output notation, parameter types, cache keys. |
| Engine | [dictionary/](./dictionary/README.md) | The dictionary text and hashes shown to models. |
| Setup | [config/](./config/README.md) | `SlimeConfig` (`slime-config.ts`), its option types, defaults and validation. |
| Shared | `shared/` | `errors.ts` (`SlimeError`, codes), `guards.ts`, `hash.ts` (`sha256`, `canonicalJSON`). |
| Tooling | `testing/` | Contract suites for every port, and test doubles. |

Every port folder has the same shape: `types.ts` holds the contract, each
implementation has its own folder or file beside it, and `testing/` has a
contract suite that every implementation, built in or custom, must pass.

## Interface

**Package entries** (`package.json` `exports`); deep imports are not part of
the API:

| Subpath | Source |
|---|---|
| `.` | `index.ts`: `createSlime`, `SlimeConfig`, `DEFAULT_TIERS`, `DEFAULT_LIMITS`, `SlimeError`, `SlimeConfigError`, `fileStore`, `memoryStore`, `DEFAULT_STORE_DIR`, `handlerKeyFor`, `changedProvenance`, `QuickJSRunner`, and every port type. |
| `./postgres` | `sources/sql/postgres/index.ts` |
| `./notion` | `sources/api/notion/index.ts` |
| `./models` | `models/index.ts`: `modelRoles`, `parseJsonReply`, `ModelClient` types |
| `./claude`, `./groq` | `models/<name>/index.ts` |
| `./tooling` | `tooling.ts`: the engine internals `@slime-cloud/crystal` uses (`executeArtifact`, `runCrystal`, `assertReadOnlySql`, `recordFromStore`, ...); not for apps |
| `./testing` | `testing/index.ts`: `describeStoreContract`, `describeConnectorContract`, `describeApiSourceContract`, `describeModelClientContract`, `cannedGenerator`, fakes |
| `./shape-worker` | `sandbox/quickjs/shape-worker.ts`, for bundlers that copy the worker |

`test/package.test.ts` pins every entry's value exports.

**`create-slime.ts`**: `createSlime(config, { runner }?)`. Startup order
(`sources/lifecycle.ts`): every source's safety check (an unsafe database
user throws `SlimeConfigError`), every source's `describe()`, then
`store.init()` and the dictionary. It emits one `warning` event when Crystal
handlers were made against another schema. A
`runner` the host passes is shared: the engine uses it and `close()` leaves it
running. Without one, the engine builds its own `QuickJSRunner` and closes it.

**`shared/errors.ts`**

- `ErrorCode`: 14 codes, from `INVALID_REQUEST` to `EXECUTION_TIMEOUT`,
  derived from the `STATUS_BY_CODE` map, so a code can't exist without a status.
- `SlimeError(code, message, { retryable = false, details }?)`; `toJSON()`
  returns `{ ...details, code, message, retryable }`.
- `SlimeConfigError(problems)`: `problems: readonly string[]`.

## Invariants

- **The main entry never loads a driver or model SDK** (C7). Adapters are
  reached only through their own subpaths.
- **Config rules** (validation, defaults, immutability, `with()`) are listed
  in [config/README.md](./config/README.md).
- **HTTP status is fixed per code.** `SlimeError.status` always comes from
  `STATUS_BY_CODE[code]`, and in `toJSON()` the fields `code`, `message` and
  `retryable` override any `details` with the same names.

## Side Effects

- No file reads `process.env` or `.env`, and no module keeps mutable state:
  every cache, pool and counter belongs to one Slime instance.
- `createSlime()` calls the connector and the store. A query runs SQL through
  the connector and shaping code in worker threads (`sandbox/quickjs/`).
- `DEFAULT_TIERS` and `DEFAULT_LIMITS` are frozen constants created at load
  time.

## Verification

- Run: `npm test -w @slime-cloud/core` (from the repository root). Tests
  mirror this folder under `test/`.
