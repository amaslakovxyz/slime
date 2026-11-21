# crystal

## Overview

Serving Crystal handlers (PLAN.md C10, M5). Crystal handlers are modules in
the app's own code, written by the crystallize job (`../../crystallize/`). The
app imports the generated `index.mjs` and passes its `crystals` as `crystal`
in `SlimeConfig`.

- `types.ts`: `CrystalHandler`, `CrystalRegistry` and `ShapeFunction`.
- `run-crystal.ts`: `runCrystal(deps, crystal, input)`.

## Interface

- `CrystalRegistry` is `Readonly<Record<requestKey, CrystalHandler>>`.
- `CrystalHandler`: `sql`, `params`, `shape` (a function or `null`), `intent`,
  `output`, `paramTypes`, `schemaHash` and `review`.
- `runCrystal(deps, crystal, input)` runs the SQL through the connector with
  the usual limits, then the shape function, then the output and R6 checks.

## Invariants

- **Crystal is served first** (`../slime-engine.ts`), keyed by request
  key, in explore and locked mode. Input types are checked against the
  recorded `paramTypes` (R4).
- **No sandbox.** The shape function runs in the app's process. The
  allowlist checked it when the job wrote it, and `slime-crystal check`
  re-checks it in the app's CI; core doesn't re-check at startup (C10). A
  throwing shape function becomes `INVALID_HANDLER`.
- **Another schema is reported once.** A handler made against another schema
  is served as it is, and `createSlime()` emits one warning.
- **Never imports the job.** This folder never imports `../../crystallize/`, so a
  serving process never loads `acorn`.

## Side Effects

- Runs SQL through the connector and the app's own shape functions.

## Verification

- `test/crystallize/crystallize.test.ts` serves a crystallized handler in locked mode.
