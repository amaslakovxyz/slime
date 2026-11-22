# sources/sql

## Overview

The SQL source port, `Connector`: the one database a Slime instance writes SQL
for. `types.ts` holds the contract; each implementation has its own folder and
its own package subpath.

- [postgres/](./postgres/README.md): `@slime-cloud/core/postgres` (needs `pg`).

## Interface

`Connector` (`types.ts`):

| Method | Does |
|---|---|
| `kind` | Always `'sql'`; API sources have `'api'` (`../api/types.ts`). |
| `name` | Shown in errors and logs. |
| `describe()` | `SchemaInfo`: the dialect and only what these credentials can read. Enum-like `values` come from the catalog, never from rows (D1). |
| `check(sql, params, limits)` | A `QueryPlan` without running the query. `cost` is in the database's own units, or `null` when it has none (the engine then skips `maxQueryCost`). |
| `run(sql, params, limits)` | Rows, capped at `limits.rowCap`, with `truncated` set when more existed. |
| `safetyCheck()` | `ok: false` when the credentials can write; `createSlime()` refuses to start (`../lifecycle.ts`). |
| `close()` | Releases connections. |

## Adding a connector

1. Copy `postgres/` to `<name>/` and export a factory from `<name>/index.ts`
   (`mysqlConnector(options): Connector`).
2. Implement the contract, with `kind: 'sql'`:
   - generated SQL uses `$1, $2, ...` placeholders; translate them if the
     driver uses another syntax;
   - run every query read-only, with a server-side timeout and a client-side
     one as backstop (generated SQL may try to lift the server's);
   - fetch `rowCap + 1` rows to know whether to set `truncated`;
   - return counts and sums as numbers, not strings;
   - map errors to `ACCESS_DENIED`, `WRITE_REFUSED`, `EXECUTION_TIMEOUT`
     (retryable), `INVALID_REQUEST` (an input value the SQL can't use) or
     `QUERY_ERROR`.
3. Add the driver as an optional peer dependency and a dev dependency, a
   `./<name>` entry in `package.json` `exports`, and the subpath to
   `test/package.test.ts`.
4. In `test/sources/sql/<name>.test.ts`, call `describeConnectorContract` from
   `@slime-cloud/core/testing` with SQL in your dialect, then add tests for
   what is specific to your database. A CI service container runs them.

## Known gaps for a non-Postgres connector

These are Postgres-specific today; fix them with the first connector that
needs it:

- the model prompts (`../../models/prompts.ts`) ask for PostgreSQL and use `::`
  casts and `to_char`. Changing their text changes every `promptHash`;
- the SQL guard (`../../engine/checks/sql.ts`) lists Postgres-only functions
  such as `pg_sleep` and `dblink`; other databases have their own.

## Verification

- `describeConnectorContract` (`../../testing/connector-contract.ts`) is the
  contract every connector must pass.
