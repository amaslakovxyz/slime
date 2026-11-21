# slime Blueprint

## System Overview

Slime (runtime and CLI `slime`) is a hackathon project in its design phase.
The repository has two halves:

- [`core/`](./core/README.md) is the engine package `@slime-cloud/core`, for
  local development and self-hosting. It answers `{ intent, input, output }`
  requests with model-generated, cached, read-only SQL against Postgres.
  [examples/express](./examples/express/README.md) shows it behind an app's
  endpoints.
- `platform/` (see [the map below](#subdirectories--system-boundaries)) is the hosted Slime Cloud:
  landing page, AWS infrastructure, the admin, and the Lambda runtime that
  runs the core for every endpoint.

The specs in `docs/` describe intent, not implemented behaviour; see
[docs/README.md](./docs/README.md) for the status of each.

### Developer notes (original)

Frontend -- sending PROMPT + Json structure for reciving
Backend -- Slime runtime:

- Recive PROMPT + JSON
- DB connection

## Subdirectories & System Boundaries

- [core/](./core/README.md) - `@slime-cloud/core`,
  the engine as an installable library. It replaced the `sandbox/` prototype,
  which was deleted in M6 (it is in git history).
  [PLAN.md](./core/PLAN.md) holds the decisions and milestones:
  M0–M3 and M5 done, M4 and M6 built (runs against a real model pending).
  The only npm workspace so far. Never imports `platform/`.
- [examples/express/](./examples/express/README.md) - an Express app
  whose endpoints are answered by `@slime-cloud/core`; its own lockfile. It
  also holds the demo database (`db/init.sql`) that core's tests and CI use.
- [examples/hono/](./examples/hono/README.md) - the smallest app around
  the core: one Hono file with `/health` and `POST /slime`.
- **`platform/` — hosted Slime Cloud**
  - [platform/landing/](./platform/landing/README.md) - Static marketing page
    (one `index.html`, no build step). Preview with `just landing`.
  - [platform/infra/](./platform/infra/README.md) - Terraform stacks:
    `bootstrap/` (human-applied roles, state bucket, budgets) and the
    CI-applied `landing/` (CloudFront + Lambda) and `platform/` (Slime runtime
    and admin on Lambda, admin CloudFront, DynamoDB, Crystal bucket).
  - [platform/runtime/](./platform/runtime/README.md) - `@slime-cloud/runtime`:
    one multi-tenant Lambda serving every endpoint under `/ep/<id>/`, the
    local per-endpoint entry, the DynamoDB handler store and S3 Crystals
    around the core. Imports `@slime-cloud/core` (`core/`); the core never
    imports it.
  - `platform/docs/` - dated reviews.
  - [platform/admin/](./platform/admin/README.md) - slime cloud admin
    (Next.js; hosted at admin.amaslakov.com, also runs locally): invite-only
    sign-up, endpoints, connector settings, the Lifecycle tab with Crystallize,
    tier usage and bill estimate. Design:
    [docs/architecture/2026-11-21-cloud-mvp-design.md](./docs/architecture/2026-11-21-cloud-mvp-design.md).
- **`docs/`** - project-wide docs, indexed with statuses in
  [docs/README.md](./docs/README.md): `product/`, `architecture/`, `brand/`.
- `.github/workflows/` (no contract file) - [ci.yml](./.github/workflows/ci.yml)
  runs pre-commit, the core, example, runtime and admin tests, the admin's
  Playwright E2E against the local stack, and the Lambda bundle build on every
  push and pull request; [terraform.yml](./.github/workflows/terraform.yml) plans every
  `platform/infra/` stack on pull requests and applies them on `main` (the landing
  page included); [terraform-quality.yml](./.github/workflows/terraform-quality.yml)
  runs tflint and trivy.


Root files: [AGENTS.md](./AGENTS.md) (repository contract for agents),
[justfile](./justfile) (task runner),
[.pre-commit-config.yaml](./.pre-commit-config.yaml) (hooks), and
[package.json](./package.json) (npm workspaces for `core` only;
`examples/express` and `platform/runtime` keep their own lockfiles).

## Global Invariants

- No runtime invariants exist in code yet (`None`).
- Enforced on every commit and in CI by
  [.pre-commit-config.yaml](./.pre-commit-config.yaml): `trailing-whitespace`,
  `end-of-file-fixer`, `check-yaml`, `check-merge-conflict`, and
  `check-added-large-files` (`--maxkb=1000`).
- Pre-commit hooks must pass; `--no-verify` is not allowed
  ([AGENTS.md](./AGENTS.md)).

## Global Side Effects

- No runtime side effects in code yet (`None`).
- CI: [ci.yml](./.github/workflows/ci.yml) job `pre-commit` runs
  `pre-commit/action@v3.0.1` on `push` and `pull_request`.
- Deploy: [terraform.yml](./.github/workflows/terraform.yml) applies every
  `platform/infra/` stack except `bootstrap/` on each push to `main` that
  touches `platform/` or `core/` (AWS account `025772230981`, `eu-central-1`);
  `platform/landing/` is served by CloudFront + Lambda.

## System Verification

- Run: `just check` (runs `pre-commit run --all-files`)
- Core package: `just core` (type-check, test, build and pack-check
  `@slime-cloud/core`)
- Install hooks once per clone: `just hooks`
