# crystallize

## Overview

The `@slime-cloud/core/crystallize` entry (PLAN.md C10, M5) and the
`slime-crystal` bin: turn proven Liquid handlers into Crystal modules in the
app's own code, and check that folder in CI. It also exports what a host
needs to load Crystal modules as data (`parseModule`, `parseManifest`,
`readManifest`): Slime Cloud's runtime imports it for that. An app that
imports its generated `index.mjs` never loads this folder.

- `crystallize.ts`: the job.
- `equivalence.ts`: the equivalence test a candidate must pass.
- `allowlist-rules.ts` and `allowlist.ts`: what a shape function may use.
- `module-format.ts`: render a module, and parse one back.
- `import-module.ts`: check a module's text, then import exactly those bytes.
- `manifest.ts`: `manifest.json` and the generated `index.mjs` /
  `index.d.mts`.
- `services.ts`: the generated `services.mjs` / `services.d.mts`, one typed
  service method per Crystal (`crystalService` from the main entry).
- `check.ts` and `bin.ts`: `slime-crystal check <dir>`.

## Interface

- `crystallize({ connector, store, dir, optimizer?, minRuns = 10, provenance?,
  limits?, runner?, optimizeTimeoutMs?, isDryRun? }): Promise<CrystalReport[]>`. The app runs it
  from its own script with its own config; core reads no env. Each report has
  an `outcome` (`crystallized`, `already`, `not-ready`, `failed`) and its
  reasons. A `runner` the host passes is used and left running; without one
  the job builds its own and closes it.
- `checkCrystalFolder(dir): Promise<string[]>`: every problem, or none.
- **Service methods.** The folder also gets `services.mjs` and
  `services.d.mts`: for each Crystal, a function named from its intent
  (`topNAccountsByTotalPaid`, kept in `manifest.json` as `service`, so it
  never changes), typed from `paramTypes` and `output`. The app calls it
  directly, `await topNAccountsByTotalPaid(connector, { limit: 5 })`, with
  no Slime instance: the SQL runs through the connector (read-only, row cap,
  timeouts), the shape runs natively, and the output and R6 checks still
  apply. Inputs are optional and nullable (R5); an unknown input name is
  `INVALID_REQUEST`.
- `slime-crystal check <dir>`: exit 0 when clean, 1 with problems, 2 on bad
  usage.
- Loading modules as data: `parseModule(source)` parses a module, checks its
  structure and runs the allowlist on its shape, and returns `{ sql, params,
  shape }` with `shape` as source text; `parseManifest(json)` and
  `readManifest(dir)` read `manifest.json` (version 1); `MANIFEST_FILE` and
  `moduleFileFor(key)` name the files.
- Also exported: `checkShapeSource`, `CrystalCodeError`, `DEFAULT_MIN_RUNS`,
  and the `Manifest`, `ManifestEntry` and `CrystalCode` types.

## Invariants

- **Ready means:** a Liquid handler whose review is `approved` (or `none`,
  when no reviewer was configured), with at least `minRuns` successful runs
  and at least one recorded input, not already in the manifest, and, when
  `provenance` is passed, made with that provenance (otherwise `not-ready`:
  "made with another schemaHash, …").
- **Candidates:** the optimizer's version first (when there is an
  optimizer), then the unchanged Liquid code. The first that passes is
  written.
- **A candidate passes when:**
  - its shape function passes the allowlist;
  - its params are inputs of the request;
  - its module passes the allowlist and the read-only SQL lint, and imports
    with exports that match its source;
  - on every recorded input it gives the same output as the Liquid handler
    (SQL plus the sandboxed shape), with floats rounded to 9 significant
    digits, list order included. The candidate's shape runs as source in the
    same sandbox and limits as Liquid's, never as a function in the job's
    process;
  - at least one input could be compared.
- **The allowlist:**
  - only the listed globals and members (`allowlist-rules.ts`);
  - no `this`, classes, async, generators, `while`/`for(;;)`/`for...in`,
    labels, `with` or dynamic `import()`;
  - no `constructor`, `prototype` or `__proto__`;
  - no computed key except number or string literals;
  - no writing to or deleting members of globals.
- **Files are `.mjs`**, so they load as ES modules in any app. Module text has
  no trailing whitespace, so pre-commit hooks never change a pinned hash.
- **`check`:**
  - re-runs the allowlist and the lint on every module, so a hand edit with a
    re-pinned hash still fails;
  - compares `index.mjs`, `index.d.mts`, `services.mjs` and
    `services.d.mts` with ones rendered from the manifest;
  - refuses `.mjs` files missing from the manifest;
  - accepts an empty folder (nothing crystallized yet).

## Side Effects

- The job reads the store, runs both versions of each handler against the
  database, may call the optimizer model, and writes the Crystal folder.
- `import-module.ts` writes a temporary copy to the OS temp folder, imports
  it, and deletes it.

## Verification

- `test/crystallize/allowlist.test.ts`: the allowlist and the module format.
- `test/crystallize/crystallize.test.ts`: the job, the optimizer and its fallbacks,
  `check`, the bin's exit codes, and serving the result.
