# postgres

## Overview

The `@slime-cloud/core/postgres` entry (PLAN.md C7, M3): a `Connector` for
Postgres. It needs the optional peer dependency `pg`; the main entry never
imports this folder.

- `postgres-connector.ts`: `postgresConnector(options)` and the connector:
  `run`, `check`, `describe`, `safetyCheck`, `close`.
- `describe.ts`: reads tables, columns, comments and keys from the catalog.
- `enum-values.ts`: allowed values of enum-like columns, from Postgres enum
  types and single-column `CHECK … IN (…)` constraints (D1).
- `safety.ts`: the startup safety check.
- `database-errors.ts`: maps pg errors to `SlimeError`.

## Interface

- `postgresConnector({ url, schema = 'public', maxConnections = 10 }):
  Connector`. `url` should be a read-only database user (`slime_reader` in
  the demo database).

## Invariants

- **Only what the user may read.** `describe()` lists only columns the user
  may `SELECT`, so a hidden column (`password_hash`) never reaches a prompt.
  Keys on hidden columns, or to tables the user can't see, are left out.
- **Enum values come from the catalog, never from rows.** The values of an
  enum type, or of a single-column `CHECK (col IN (…))`, become
  `ColumnInfo.values`.
- **Each `run` and `check` is guarded:**
  - it runs in a `READ ONLY` transaction with `SET LOCAL statement_timeout`;
  - the client also gives up `CLIENT_TIMEOUT_MARGIN_MS` (1 s) later, because
    generated SQL could lift the server-side timeout with `set_config()`;
  - the connection is rolled back, and destroyed if the rollback fails.
- **Generated SQL is wrapped as a subquery** with `LIMIT rowCap + 1`. A
  second statement then becomes a syntax error, and more rows than `rowCap`
  set `truncated`.
- **`check` only plans.** It runs `EXPLAIN (FORMAT JSON)` and returns the
  planner cost; the engine compares it with `limits.maxQueryCost`.
- **Numbers stay numbers.** `int8` and `numeric` are parsed as numbers
  (`COUNT`, `SUM` would otherwise be strings). This is set on the pool, not
  globally, so the app's own `pg` settings stay untouched.
- **Error mapping:**
  - `42501` (insufficient privilege) → `ACCESS_DENIED`;
  - `25006` (write in a read-only transaction) → `WRITE_REFUSED`;
  - timeouts → `EXECUTION_TIMEOUT` (retryable);
  - class `22` (data exception) quoting a bound input value, such as
    `invalid input syntax for type integer: "many"` → `INVALID_REQUEST`:
    the caller's value is wrong, not the SQL;
  - anything else → `QUERY_ERROR` with `details.sqlState`.
- **The safety check refuses:**
  - superusers (including `rds_superuser`);
  - roles that can create roles or databases;
  - users that can `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` any table
    (up to 5 listed).

## Side Effects

- Opens a `pg.Pool` per connector; `close()` ends it.

## Verification

- `test/connectors/postgres.test.ts` runs the Connector contract, then the
  Postgres-specific cases, against the demo database from
  `examples/express/db/init.sql` (`npm run db:up` in that folder
  locally; a service in CI). URLs come from `DATABASE_URL` and
  `WRITER_DATABASE_URL`, with local defaults. Locally the database tests are skipped when Postgres is down; CI
  sets `REQUIRE_DB=1`, so they fail instead.
