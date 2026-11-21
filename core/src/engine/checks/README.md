# checks

## Overview

Static checks run on model-generated handler code (an `Artifact`) before it
touches the database. The checks are defence in depth only: the read-only
database user is the real boundary. `sql.ts` refuses SQL that writes or calls a
forbidden function, checks that `$n` placeholders map to real input names, and
rejects handlers that copy an input value into their code.

`limit.ts` holds the R6 check: a top-level list may not have more rows than
`input.limit`. These functions are internal: the engine calls them
(`engine/generate.ts`, `engine/execute.ts`), and `src/index.ts` does not
re-export them.

## Interface

- `assertReadOnlySql(sql: string): void` (`sql.ts`): throws
  `SlimeError('WRITE_REFUSED', ..., { details: { enforcedBy: 'lint' } })` when `sql`
  matches the `WRITE_SQL` pattern. Otherwise it returns without a value.
- `lintArtifact(artifact: Artifact, input: Readonly<Record<string, unknown>>): void`
  (`sql.ts`): calls `assertReadOnlySql(artifact.sql)` and then validates the
  parameter mapping and checks for hardcoded values. Throws
  `SlimeError('INVALID_HANDLER', ...)` on any failure.
- `assertWithinLimit(data: unknown, input: InputValues): void` (`limit.ts`):
  throws `SlimeError('INVALID_HANDLER', ...)` when `data` is a list longer
  than a numeric `input.limit`. Anything else passes.
- Dependencies: `SlimeError` from `../../shared/errors.ts`, `Artifact` type from
  `../../models/types.ts`.

## Invariants

- `WRITE_SQL` matches whole words, case-insensitively: `insert`, `update`,
  `delete`, `merge`, `drop`, `alter`, `create`, `grant`, `revoke`, `truncate`,
  `copy`, `vacuum`, `set_config`, `pg_sleep`, `pg_read_file`, `lo_import`,
  `dblink`. The `\b` boundaries mean identifiers such as `created_at` do not
  match (covered by `test/engine/checks/sql.test.ts`).
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
  `STATUS_BY_CODE` in `../../shared/errors.ts`). Both are thrown with `retryable` false.

## Side Effects

- None. Both functions are pure apart from throwing `SlimeError`. They do no
  I/O and change no state.

## Verification

- Run: `npm test -w @slime-cloud/core` (from the repository root). Tests for
  this directory are in `test/engine/checks/sql.test.ts`.
