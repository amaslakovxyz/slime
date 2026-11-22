# artifact

## Overview

What a model writes: the handler's code, before Slime has run it.

- `artifact.ts`: `Artifact` (`{ version: 2, unsatisfiable, steps, shapeJs,
  assumptions }`, MS3), its step types, `sqlOf`, and the two conversions:
  `fromStoredArtifact` reads the older single-query form from stored records,
  and `asSingleQuery` gives Crystal its one-query form.
- `checks/`: model-free checks of that code, run before it touches a source.
  They are defence in depth only: the read-only database user is the real
  boundary.
  - `sql.ts`: refuses SQL that writes or calls a forbidden function, checks
    that `$n` placeholders map to real input names, and rejects code that
    copies an input value.
  - `steps.ts`: step names, sources, operations and API arguments (MS4); runs
    `sql.ts` on each SQL step.

The checks are internal: the engine calls them, and `src/index.ts` does not
re-export them.

## Interface

- `assertReadOnlySql(sql: string): void` (`checks/sql.ts`): throws
  `SlimeError('WRITE_REFUSED', ..., { details: { enforcedBy: 'lint' } })` when `sql`
  matches the `WRITE_SQL` pattern. Otherwise it returns without a value.
- `lintArtifact(code: SqlCode, input: Readonly<Record<string, unknown>>): void`
  (`checks/sql.ts`, where `SqlCode` is one SQL step's `sql` and `params` with
  the handler's `shapeJs`): calls `assertReadOnlySql(artifact.sql)` and then validates the
  parameter mapping and checks for hardcoded values. Throws
  `SlimeError('INVALID_HANDLER', ...)` on any failure.
- `lintSteps(artifact, { sqlSourceName, apiSchemas, input, maxSteps }): void`
  (`checks/steps.ts`): throws `SlimeError('INVALID_HANDLER', ...)` for the
  first problem.

## Invariants

- `WRITE_SQL` matches whole words, case-insensitively: `insert`, `update`,
  `delete`, `merge`, `drop`, `alter`, `create`, `grant`, `revoke`, `truncate`,
  `copy`, `vacuum`, `set_config`, `pg_sleep`, `pg_read_file`, `lo_import`,
  `dblink`. The `\b` boundaries mean identifiers such as `created_at` do not
  match (covered by `test/artifact/checks/sql.test.ts`).
- The keyword match runs over the raw SQL text, so a forbidden word inside a
  string literal or comment is also refused.
- Placeholder mapping (`lintArtifact`), where `artifact.params[i]` binds
  `$(i+1)`:
  - The highest `$n` used in `artifact.sql` must not exceed
    `artifact.params.length`.
  - Every name in `artifact.params` must be a key of `input`.
  - Every mapped placeholder `$(i+1)` must appear in `artifact.sql`.
- Hardcoded-value check: for every `input` value that is a string of at least
  `MIN_HARDCODED_LENGTH` (3) characters, the value must not appear verbatim in `artifact.sql` or
  `artifact.shapeJs`. The model never sees input values, so a match means the
  value was copied from the intent. Non-string values and strings of 2
  characters or fewer are not checked.
- Checks run in order (read-only, placeholder bound, per-param mapping,
  hardcoded values), and the first failure throws.
- `WRITE_REFUSED` maps to HTTP 403 and `INVALID_HANDLER` maps to HTTP 500 (via
  `STATUS_BY_CODE` in `../shared/errors.ts`). Both are thrown with `retryable` false.

## Side Effects

- None. Everything here is pure apart from throwing `SlimeError`: no I/O, no
  state.

## Verification

- Run: `npm test -w @slime-cloud/core` (from the repository root). Tests for
  this directory are in `test/artifact/`.
