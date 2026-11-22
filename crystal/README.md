# @slime-cloud/crystal

## Overview

Crystallize turns proven Liquid handlers into Crystal: reviewed code in the
app's own repository (PLAN.md C10, M5). This package is the build-time side:

- the crystallize job, which writes the Crystal folder (modules, manifest,
  `index.mjs`, typed `services.mjs`, and the `cases` each Crystal is verified
  against);
- the `slime-crystal` CLI for CI and for whoever edits the folder: `check`,
  `pin` and `verify`;
- what a host needs to load Crystal modules as data (`parseModule`,
  `parseManifest`, `readManifest`): Slime Cloud's runtime imports it for that.

Serving Crystal is not here: `@slime-cloud/core` runs it (`runCrystal`, and
`crystalService` behind `services.mjs`), so an app that imports its generated
`index.mjs` or `services.mjs` never loads this package or `acorn`. This package
uses core's internals through `@slime-cloud/core/tooling` and peers on the
exact core version.

```sh
npm install --save-dev @slime-cloud/crystal   # beside @slime-cloud/core
```

From a running instance, nothing is configured twice:

```js
import { Crystallizer } from '@slime-cloud/crystal';

const crystallizer = new Crystallizer(slime, { dir: './slime-crystal' });
await crystallizer.run();              // ready Liquid handlers → Crystal; equivalence checked before writing
await crystallizer.run({ keys });      // only these request keys
await crystallizer.verify();           // the folder against this instance's database
```

It uses the instance's connector, store, sandbox, limits and provenance, its
`tiers.crystalReadyRuns` as the default `minRuns` (the threshold of core's
`crystalReady` event, so the event and the job agree), and its **live** run counts: after promotion a handler's runs and fixtures grow in
memory only, so a job that reads the store alone sees too few runs. The
standalone `crystallize({ connector, store, dir })` is for hosts that keep the
store's counts current themselves (Slime Cloud syncs them).

Source layout (`src/`):

- `crystallize.ts`: the job.
- `crystallizer.ts`: `Crystallizer`, the job from a running instance.
- `equivalence.ts`: the equivalence test a candidate must pass.
- `allowlist-rules.ts` and `allowlist.ts`: what a shape function may use.
- `module-format.ts`: render a module, and parse one back.
- `import-module.ts`: check a module's text, then import exactly those bytes.
- `manifest.ts`: `manifest.json` and the generated `index.mjs` /
  `index.d.mts`.
- `services.ts`: the generated `services.mjs` / `services.d.mts`, one typed
  service method per Crystal (`crystalService` from `@slime-cloud/core`).
- `cases.ts`: `<key>.cases.json`, the reference a Crystal is verified
  against: the Liquid handler's code and its recorded inputs.
- `pin.ts`: re-pins edited modules (never a cases file).
- `verify.ts`: equivalence with the reference and plan cost, on a database.
- `check.ts` and `bin.ts`: `slime-crystal check | pin | verify`.

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
  usage. No database or model.
- **Editing a Crystal** (a person or an agent optimizing it):
  1. edit `<key>.mjs` (only `sql`, `params` and `shape`);
  2. `slime-crystal pin <dir>`: re-runs the allowlist and the read-only lint on
     each changed module, pins its new hash (`isOptimized: true`) and
     regenerates `index.mjs` and `services.mjs`. It never re-pins a cases file;
  3. `slime-crystal verify <dir> --database-url <read-only url>`: `check`, then
     on every recorded input the Crystal's output must equal the Liquid
     reference's (both run against that database), and its plan cost must be
     at most `COST_TOLERANCE` (1.1) times the reference's. This is the gate for
     merging an edit; reviews, human or agent, come on top of it.
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
  - refuses a cases file whose hash differs from the one crystallize pinned:
    only crystallize writes the reference;
  - accepts an empty folder (nothing crystallized yet).

## Side Effects

- The job reads the store, runs both versions of each handler against the
  database, may call the optimizer model, and writes the Crystal folder.
- `import-module.ts` writes a temporary copy to the OS temp folder, imports
  it, and deletes it.

## Verification

Run `npm run build -w @slime-cloud/core` first: this package type-checks and
runs against core's `dist/`. Then `npm test -w @slime-cloud/crystal`.

- `test/allowlist.test.ts`: the allowlist and the module format.
- `test/crystallize.test.ts`: the job, the optimizer and its fallbacks,
  `check`, the bin's exit codes, serving the result, and service methods.
- `test/services.test.ts`: service names and types.
- `test/verify.test.ts`: `pin` and `verify`, with fakes and against the demo
  Postgres.
- `test/engine.test.ts`: the job with a real engine (a shared sandbox, MS9).
- `test/crystallizer.test.ts`: `Crystallizer` with live run counts and keys.
- `test/boundary.test.ts`: core is reached only through its package entries.
