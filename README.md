# slime Blueprint

## System Overview

Slime (runtime and CLI `slime`) is a hackathon project. The repository has
two halves:

- [`core/`](./core/README.md) is the engine package `@slime-cloud/core`, for
  local development and self-hosting. It answers `{ intent, input, output }`
  requests with model-generated, cached, read-only handlers over Postgres,
  Notion and REST API sources. [`crystal/`](./crystal/README.md)
  (`@slime-cloud/crystal`) turns its proven handlers into code in your repo.
  [examples/express](./examples/express/README.md) shows it behind an app's
  endpoints.
- `platform/` (see [the map below](#subdirectories--system-boundaries)) is the hosted Slime Cloud:
  landing page, AWS infrastructure, the admin, and the Lambda runtime that
  runs the core for every endpoint.

Project-wide specs live in `docs/`; [docs/README.md](./docs/README.md) gives
each one a status (Current, Design, Vision, Plan, Record, Superseded).

## Subdirectories & System Boundaries

- [core/](./core/README.md) - `@slime-cloud/core`,
  the engine as an installable library. It replaced the `sandbox/` prototype,
  which was deleted in M6 (it is in git history).
  [PLAN.md](./core/PLAN.md) holds the decisions and milestones:
  M0–M3, M5 and M7 done; M4 and M6 built (real-model runs pending).
  An npm workspace. Never imports `platform/`.
- [crystal/](./crystal/README.md) - `@slime-cloud/crystal`, the build-time
  side of Crystal: the crystallize job, typed service methods and the
  `slime-crystal` CLI (`check`, `pin`, `verify`). The second npm workspace; uses
  core's internals through `@slime-cloud/core/tooling`.
- [examples/express/](./examples/express/README.md) - an Express app
  whose endpoints are answered by `@slime-cloud/core`; its own lockfile. It
  also holds the demo database (`db/init.sql`) that core's tests and CI use.
- [examples/hono/](./examples/hono/README.md) - the smallest app around
  the core: one Hono file with `POST /slime`, `POST /crystallize` and `GET /health`.
- [examples/multi-source/](./examples/multi-source/README.md) - one instance
  over Postgres, Notion and two public APIs (films, euro rates); replays
  recorded API responses, so its tests run in CI without accounts.
- [examples/customer-site/](./examples/customer-site/README.md) - a customer's
  site with no data backend: three panels answered by a Slime Cloud endpoint
  (one through its Crystal) and the multi-source example; the customer demo.
- [examples/shop/](./examples/shop/README.md) - a demo online-shop database
  (12 tables, deterministic) loaded into the cloud test RDS as database `shop`,
  with 10 demo use cases that run through the bench (`BENCH_CASES`).
- **`platform/` — hosted Slime Cloud**
  - [platform/landing/](./platform/landing/README.md) - Static marketing page
    (one `index.html`, no build step). Preview with `just landing`.
  - [platform/infra/](./platform/infra/README.md) - Terraform stacks:
    `bootstrap/` (human-applied roles, state bucket, budgets) and the
    CI-applied `landing/` (CloudFront + Lambda), `platform/` (Slime runtime
    and admin on Lambda, admin CloudFront, DynamoDB, Crystal bucket, alarms)
    and `atlas/` (the [customer-site](./examples/customer-site/README.md)
    demo on a public Lambda Function URL). Cost controls:
    [FINOPS.md](./platform/infra/FINOPS.md).
  - [platform/runtime/](./platform/runtime/README.md) - `@slime-cloud/runtime`:
    one multi-tenant Lambda serving every endpoint under `/ep/<id>/`, the
    local per-endpoint entry, the DynamoDB handler store and S3 Crystals
    around the core. Imports `@slime-cloud/core` (`core/`); the core never
    imports it.
  - `platform/docs/reviews/` - dated reviews (Records), indexed in
    [docs/README.md](./docs/README.md#code-local-docs).
  - [platform/admin/](./platform/admin/README.md) - slime cloud admin
    (Next.js; hosted at admin.amaslakov.com, also runs locally): invite-only
    sign-up, endpoints, connector settings, the Lifecycle tab with Crystallize,
    tier usage and bill estimate. Design:
    [docs/architecture/2026-11-21-cloud-mvp-design.md](./docs/architecture/2026-11-21-cloud-mvp-design.md).
- **`docs/`** - project-wide docs, indexed with statuses in
  [docs/README.md](./docs/README.md): `product/`, `architecture/`, `brand/`.
- `.github/workflows/` (no contract file) - [ci.yml](./.github/workflows/ci.yml)
  runs pre-commit, the core, crystal, example, runtime and admin tests, the
  admin's Playwright E2E against the local stack, the landing function tests
  and the Lambda bundle build on every push and pull request;
  [terraform.yml](./.github/workflows/terraform.yml) plans every
  `platform/infra/` stack except `bootstrap/` on pull requests and applies
  them on `main`; [terraform-quality.yml](./.github/workflows/terraform-quality.yml)
  runs tflint and trivy; [crystal-agents.yml](./.github/workflows/crystal-agents.yml)
  (weekly or manual; Claude through Workload Identity Federation, no stored key) grows the
  express example's handlers to Crystal, lets writer and reviewer agents
  ([crystal/agents/](./crystal/agents/)) optimize them, and opens a PR;
  [anthropic-wif.yml](./.github/workflows/anthropic-wif.yml) (manual) checks that
  federation: token exchange, a Messages call, the `claude` CLI.

Root files: [AGENTS.md](./AGENTS.md) (repository contract for agents),
[justfile](./justfile) (task runner),
[.pre-commit-config.yaml](./.pre-commit-config.yaml) (hooks),
[.tflint.hcl](./.tflint.hcl) and [.trivyignore.yaml](./.trivyignore.yaml)
(Terraform checks; each accepted trivy finding carries its rationale), and
[package.json](./package.json) (npm workspaces for `core` and `crystal`;
the npm examples (express, hono, multi-source, customer-site),
`platform/runtime` and `platform/admin` keep their own lockfiles).

## Global Invariants

- `core/` and `crystal/` never import `platform/` or the AWS SDK; CI's
  "Core and Crystal tests" job fails if they do.
- Enforced on every commit and in CI by
  [.pre-commit-config.yaml](./.pre-commit-config.yaml): `trailing-whitespace`,
  `end-of-file-fixer`, `check-yaml`, `check-merge-conflict`, and
  `check-added-large-files` (`--maxkb=1000`).
- Pre-commit hooks must pass; `--no-verify` is not allowed
  ([AGENTS.md](./AGENTS.md)).

## Global Side Effects

- CI: [ci.yml](./.github/workflows/ci.yml) job `pre-commit` runs
  `pre-commit/action@v3.0.1` on `push` and `pull_request`.
- Deploy: [terraform.yml](./.github/workflows/terraform.yml) applies every
  `platform/infra/` stack except `bootstrap/` on each push to `main` that
  touches `platform/`, `core/`, `crystal/`, the root `package.json` /
  `package-lock.json` or `examples/customer-site/` (AWS account
  `025772230981`, `eu-central-1`).
- Runtime side effects (DynamoDB, S3, SSM, model API calls) are listed per
  component in [platform/runtime/README.md](./platform/runtime/README.md) and
  [platform/admin/README.md](./platform/admin/README.md).

## System Verification

- Run: `just check` (runs `pre-commit run --all-files`)
- Core and Crystal packages: `just core` (type-check, test, build and
  pack-check `@slime-cloud/core` and `@slime-cloud/crystal`)
- Runtime bundle: `just runtime-build`; plan a stack: `just tf-plan <stack>`
- Landing preview: `just landing`
- Install hooks once per clone: `just hooks`
