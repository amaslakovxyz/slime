# request

## Overview

The request format of `@slime-cloud/core`: how a caller's `{ intent, input?, output }`
is validated, how the `output` shape notation is checked against generated
results, how per-handler parameter types are recorded, and how cache keys are
derived. Every module here is pure (no I/O). Validation failures are thrown as
`SlimeError('INVALID_REQUEST')` from [`../errors.ts`](../errors.ts) (HTTP status 400,
not retryable). Design background lives in [`PLAN.md`](../../PLAN.md) §4.1 to §4.3
and rules R2 to R7.

Only the types `InputScalar`, `InputValue`, `SlimeRequest`, `ParamType` and
`Shape` are part of the public package API (re-exported from
[`../index.ts`](../index.ts)). The functions are internal to the engine; deep
imports are not part of the API. [`../ports.ts`](../ports.ts) imports `ParamType`
and `Shape`.

## Interface

### `parse.ts`: request parsing

- `type InputScalar = string | number | boolean | null`
- `type InputValue = InputScalar | InputScalar[]`
- `interface SlimeRequest { intent: string; input?: Record<string, InputValue>; output: Shape }`:
  what `slime.query()` will accept (M2).
- `interface ParsedRequest { intent; input; output }`: `input` is always present
  (defaults to `{}`).
- `const PAGING_PARAMS = ['limit', 'offset']`: reserved paging input names (R6).
- `parseRequest(raw: unknown): ParsedRequest`: validates a raw request or throws
  `INVALID_REQUEST` with an actionable message.
- `literalsInIntent(intent: string): string[]`: labels literal values found in
  the intent (`'quoted text'`, `'a number'`, `'an email address'`, `'a UUID'`).
  It only detects. R7 (adding a warning to `meta.warnings`, not an error,
  because "top 10" and possessives match too) is the engine's job from M2.

### `shape.ts`: output shape notation (§4.2)

- `type Shape = string | readonly Shape[] | { readonly [key: string]: Shape }`:
  leaves are type names (`string`, `number`, `integer`, `boolean`, `date`,
  `datetime`, each optionally `|null`); a one-element array is a list; an object
  has exactly those keys.
- `assertValidShape(shape: unknown): asserts shape is Shape`: rejects malformed
  shapes before anything is generated.
- `validateData(shape: Shape, data: unknown): string[]`: checks a handler result;
  accepts `null` when the top-level shape is an object (one row, no row found).
- `validateAgainstShape(shape, value, path = '$', out = []): string[]`: returns
  `$`-rooted mismatch messages; empty means the value matches.

### `params.ts`: parameter types (R4, R5)

- `type ParamType = 'string' | 'number' | 'boolean' | 'list'`
- `type ParamTypes = Record<string, ParamType | null>`: `null` while only `null`
  has been seen.
- `coarseType(value: InputValue): ParamType | null`
- `checkParamTypes(known, input): ParamTypes`: checks `input` against a handler's
  recorded types and returns the updated record, or throws `INVALID_REQUEST`.

### `key.ts`: cache keys (§4.3, R2 to R4)

- `sha256(text: string): string`: hex digest via `node:crypto`.
- `canonicalJSON(value: unknown): string`: JSON with object keys sorted at every level.
- `normalizeIntent(intent: string): string`
- `requestKey(req: ParsedRequest): string`: 64 hex characters.
- `interface HandlerProvenance { schemaHash; dictionaryHash; promptHash; model }`:
  what a handler was generated against, stored inside the handler.
- `changedProvenance(saved, current): (keyof HandlerProvenance)[]`: the fields
  that differ, in a fixed order.

## Invariants

### Request parsing (`parse.ts`)

- The request must be a plain object (prototype `Object.prototype` or `null`).
  Only the fields `intent`, `input` and `output` are allowed.
- `intent` is a string, non-empty after trim, at most 500 characters (`MAX_INTENT`).
- `input` is a plain object with at most 20 keys (`MAX_INPUT_KEYS`). Each name matches
  `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/`. Each value is `null`, a string, a boolean, a
  finite number, or an array of those (NaN and Infinity are rejected).
- `input.limit` and `input.offset`, when present and not `null`, must be
  non-negative safe integers.
- `output` is required and must pass `assertValidShape`.

### Shape notation (`shape.ts`)

- A leaf matches `/^(string|number|integer|boolean|date|datetime)(\|null)?$/`. A
  list is an array with exactly one element. An object has at least one key.
- Limits: depth at most 6 (objects and lists both count), at most 50 leaves.
  Shape errors are prefixed `Invalid output shape:`.
- `validateAgainstShape` collects at most 10 mismatches. Object values must
  have every requested key (`missing`) and no extra keys (`not requested`).
  Non-nullable leaves reject `null`.
- Leaf checks: `number` is finite; `integer` uses `Number.isInteger`; `date` is
  `YYYY-MM-DD` naming a real day (`2026-02-30` is rejected); `datetime` is ISO 8601
  with a required zone (`Z` or `±hh:mm`) so a value never depends on the server zone.

### Parameter types (`params.ts`)

- The first non-null value fixes a parameter's coarse type. Later values of
  another type are refused. Whole and decimal numbers are both `number`; any
  array is `list`.
- `null` fits every type and never overwrites a recorded type. Recorded names
  absent from `input` are kept.
- All mismatches are collected before throwing, so one `INVALID_REQUEST` (with
  `details.mismatches`) reports every mismatch.

### Cache keys (`key.ts`)

- `normalizeIntent` is deterministic: NFKC, lowercase, single spaces, trimmed,
  trailing `.!?;:,` removed. No synonyms and no model (R3).
- `requestKey` hashes `{ v: 1, normalized intent, sorted input NAMES, output }`.
  Input values and input types are never part of the key.
- The request key alone is a handler's store key (§4.7). Provenance is stored
  inside the handler, never hashed into the key, so locked mode (no generator,
  possibly a slightly different schema) finds what explore mode saved.
- Explore mode treats any `changedProvenance` result as a miss and
  regenerates; locked mode serves the handler and warns once if `schemaHash`
  changed. The engine applies this from M2.
- Bumping the `v: 1` field invalidates every existing key; change it only on purpose.

## Side Effects

- None: no I/O, network, disk or global state. `checkParamTypes` returns a new
  record and does not mutate `known`.
- `validateAgainstShape` pushes into the caller-supplied `out` array and returns
  that same array.

## Verification

- Run from the repository root: `npm test -w @slime-cloud/core`
- Tests: `test/request.test.ts`, `test/shape.test.ts`, `test/params.test.ts`, `test/key.test.ts`
  (under `oss/packages/core/`).
