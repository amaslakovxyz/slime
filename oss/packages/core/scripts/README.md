# scripts

## Overview

Maintenance scripts for the `@slime-cloud/core` package. They are not part
of the published package: `package.json` `files` lists only `dist` and
`README.md`. Today there is one script, the pack check, which guards what
`npm pack` would ship (PLAN.md decision C8: compiled JS and types, no
sources).

## Interface

- `check-pack.mjs`: run as `npm run check:pack -w @slime-cloud/core`
  (`package.json` `scripts.check:pack`) or `node scripts/check-pack.mjs`.
  - It takes no arguments, flags or environment variables.
  - It always checks the package directory one level above the script
    (`pkgDir`), whatever the current directory.

## Invariants

- **Must ship** (`required`): `package.json`, `README.md`, `dist/index.js`
  and `dist/index.d.ts`. Each missing file is reported as `missing <file>`.
- **Must not ship** (`forbidden`): any path matching `^src/`, `^test/`,
  `^scripts/`, `^tsconfig`, `^PLAN.md$` or `^docs/`. Each match is reported
  as `should not ship <file>`.
- **The file list comes from npm itself:** the first report of
  `npm pack --dry-run --json`, taking `files[].path`, sorted. It therefore
  follows npm's real packing rules, including the `files` allowlist.
- **`dist/` must already be built.** The check passes `--ignore-scripts`, so
  `prepack` (which runs `npm run build`) is not triggered. Run
  `npm run build -w @slime-cloud/core` first, as CI does.

## Side Effects

- Spawns `npm pack --dry-run --json --ignore-scripts` synchronously
  (`execFileSync`), with the package directory as its working directory.
- Writes no files: `--dry-run` produces no tarball.
- **On failure:** writes the problems and the full packed file list to
  stderr, then exits with code 1 (`process.exit(1)`).
- **On success:** prints
  `npm pack check passed: <name>@<version>, <N> files, <size> bytes` to
  stdout.
- **Unhandled errors:** if `npm` exits non-zero or prints invalid JSON, the
  script throws and exits non-zero.
- No network access in the script itself; it only calls the local npm CLI.

## Verification

- Run: `npm run build -w @slime-cloud/core && npm run check:pack -w @slime-cloud/core`
  (from the repository root)
