# src

## Overview

The sources of `@slime-cloud/core`, compiled into `dist/` by
`tsconfig.build.json`. `createSlime()` (`create-slime.ts`) builds a Slime
instance from a `SlimeConfig`.

The folders say what the system is made of:

| Kind | Folder | What it is |
|---|---|---|
| **Port** | [connectors/](./connectors/README.md) | Where data comes from. `types.ts` + `postgres/`. |
| **Port** | [models/](./models/README.md) | Generator, Reviewer, Optimizer. `types.ts`, `ModelClient` + `claude/`, `groq/`, `offline/`. |
| **Port** | `sources/` | Read-only API sources beside the SQL connector (MS1–MS17). `types.ts` (`ApiSource`) + `call-source.ts` (timeout, redaction), `api/` (`defineApiSource`, the constrained HTTP client) and `notion/`. |
| **Port** | [stores/](./stores/README.md) | Slime's own key-value state. `types.ts` + file and memory stores. |
| **Port** | [sandbox/](./sandbox/README.md) | Where generated shaping code runs. `types.ts` + `quickjs/`. |
| Engine | [engine/](./engine/README.md) | The Slime instance: handler cache, generation, review, promotion; `crystal/` serves Crystal handlers, `checks/` guards generated SQL. |
| Engine | [request/](./request/README.md) | Parsing `{ intent, input?, output }`, the output notation, parameter types, cache keys. |
| Engine | [dictionary/](./dictionary/README.md) | The dictionary text and hashes shown to models. |
| Setup | [config/](./config/README.md) | `SlimeConfig` (`slime-config.ts`), its option types, defaults and validation. |
| Shared | `shared/` | `errors.ts` (`SlimeError`, codes), `guards.ts`, `hash.ts` (`sha256`, `canonicalJSON`). |
| Tooling | [crystallize/](./crystallize/README.md) | The crystallize job and `slime-crystal check`. |
| Tooling | `testing/` | Contract suites for every port, and test doubles. |

Every port folder has the same shape: `types.ts` holds the contract, each
implementation has its own folder or file beside it, and `testing/` has a
contract suite that every implementation, built in or custom, must pass.

## Interface

**Package entries** (`package.json` `exports`); deep imports are not part of
the API:

| Subpath | Source |
|---|---|
| `.` | `index.ts`: `createSlime`, `SlimeConfig`, `DEFAULT_TIERS`, `DEFAULT_LIMITS`, `SlimeError`, `SlimeConfigError`, `fileStore`, `memoryStore`, `DEFAULT_STORE_DIR`, `handlerKeyFor`, and every port type. |
| `./postgres` | `connectors/postgres/index.ts` |
| `./notion` | `sources/notion/index.ts` |
| `./models` | `models/index.ts`: `modelRoles`, `parseJsonReply`, `ModelClient` types |
| `./claude`, `./groq`, `./offline` | `models/<name>/index.ts` |
| `./crystallize` | `crystallize/index.ts` (and the `slime-crystal` bin) |
| `./testing` | `testing/index.ts`: `describeStoreContract`, `describeConnectorContract`, `describeModelClientContract`, fakes |
| `./shape-worker` | `sandbox/quickjs/shape-worker.ts`, for bundlers that copy the worker |

`test/package.test.ts` pins every entry's value exports.

**`create-slime.ts`**: `createSlime(config)`. Startup order: the
connector's safety check (an unsafe user throws `SlimeConfigError`),
`store.init()`, `describe()` and the dictionary. In locked mode it emits one
`warning` event when saved handlers were made against another schema.

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
