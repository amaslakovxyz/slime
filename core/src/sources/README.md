# sources

## Overview

Where an app's data comes from. A Slime instance has exactly one SQL source and
any number of API sources (MS1); a handler's steps read from them.

- `types.ts`: `Source` (a `Connector` or an `ApiSource`), `isApiSource`, and
  the types both kinds share: `ColumnInfo`, `RunResult`, `SafetyReport`.
- `lifecycle.ts`: `startSources` (every safety check, then every schema) and
  `closeSources` (every source, even when one fails).
- [sql/](./sql/README.md): the `Connector` port and
  [sql/postgres/](./sql/postgres/README.md) (`@slime-cloud/core/postgres`).
- `api/`: the `ApiSource` port (`types.ts`) and what every API source shares:
  - `call-source.ts`: one timeout, secret redaction and one error type for
    every call (MS7, MS16); `source-error.ts`: what an adapter throws;
    `plain-rows.ts`: rows must be plain JSON before they reach the sandbox;
  - `declaration.ts` and `define-api-source.ts`: `defineApiSource`, any REST
    API declared in app code;
  - `http/`: the constrained HTTP client (base URL only, capped reads,
    retries);
  - `notion/`: the Notion adapter (`@slime-cloud/core/notion`).

## Adding a source

- **Another database:** a `Connector`; see [sql/README.md](./sql/README.md).
- **A REST API:** usually no adapter at all: `defineApiSource({ service,
  baseUrl, operations })` in app code.
- **An API that needs its own logic** (pagination, a schema read at startup,
  like Notion): implement `ApiSource` in `api/<name>/`, throw `SourceError`
  for failed calls, and pass `describeApiSourceContract` from
  `@slime-cloud/core/testing`.

## Invariants

- **Read-only.** A source whose safety check fails stops `createSlime()`.
- **Metadata only, never rows,** goes to the model: `describe()` returns
  schemas (D1).
- **API calls are time-limited and redacted** through `callSource`; the SQL
  source has its own server- and client-side timeouts.
