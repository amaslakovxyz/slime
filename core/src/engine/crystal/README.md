# crystal

## Overview

Serving Crystal handlers (PLAN.md C10, M5). Crystal handlers are modules
written by the crystallize job (`../../crystallize/`). An app imports the
generated `index.mjs` and passes its `crystals` as `crystal` in `SlimeConfig`;
its shapes are functions. A host that stores the modules elsewhere (Slime
Cloud: S3) parses them with `parseModule` from `@slime-cloud/core/crystallize`
and passes handlers whose shapes are the source strings.

- The types (`CrystalHandler`, `CrystalRegistry`, `ShapeFunction`) are in
  `../../handler/crystal.ts`.
- `run-crystal.ts`: `runCrystal(deps, crystal, input)`.

## Interface

- `CrystalRegistry` is `Readonly<Record<requestKey, CrystalHandler>>`.
- `CrystalHandler`: `sql`, `params`, `shape` (a function, the source of
  `function shape(rows, input)`, or `null`), `intent`, `output`, `paramTypes`,
  `schemaHash` and `review`.
- `runCrystal({ connector, runner?, limits }, crystal, input)` runs the SQL
  through the connector with the usual limits, then the shape, then the output
  and R6 checks. A string shape needs the `runner`; the engine passes its own.

## Invariants

- **Crystal is served first** (`../slime-engine.ts`), keyed by request
  key, in explore and locked mode. Input types are checked against the
  recorded `paramTypes` (R4).
- **Function shapes: no sandbox.** A function shape runs in the app's
  process. The allowlist checked it when the job wrote it, and
  `slime-crystal check` re-checks it in the app's CI; core doesn't re-check at
  startup (C10). A throwing shape function becomes `INVALID_HANDLER`.
- **String shapes: the sandbox.** A string shape runs through the engine's
  `SandboxRunner` with Liquid's `shapeTimeoutMs` and `shapeMemoryBytes`, the
  same path as `executeArtifact`; failures are `SANDBOX_ERROR`. Nothing is
  imported or evaluated in the host's process.
- **Another schema is reported once.** A handler made against another schema
  is served as it is, and `createSlime()` emits one warning.
- **Never imports the job.** This folder never imports `../../crystallize/`, so a
  serving process never loads `acorn`.

## Side Effects

- Runs SQL through the connector, and the shape in the app's process
  (function) or in the sandbox (string).

## Verification

- `test/crystallize/crystallize.test.ts` serves a crystallized handler in locked mode.
- `test/engine/crystal.test.ts`: string shapes give the function form's data
  and stop at the shape time limit; an injected runner outlives `close()`.
