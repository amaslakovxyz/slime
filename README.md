# slime Blueprint

## System Overview

Slime (runtime and CLI `slime`) is a hackathon project in its design phase.
The only code is a prototype in [sandbox/](./sandbox/README.md). It has one
data endpoint and uses Claude to generate read-only SQL against a demo Postgres.
Its benchmark measures generation speed and correctness. The specs in `docs/`
describe intent, not implemented behaviour.

### Developer notes (original)

Frontend -- sending PROMPT + Json structure for reciving
Backend -- Slime runtime:

- Recive PROMPT + JSON
- DB connection

## Subdirectories & System Boundaries

- [landing/](./landing/README.md) - Static marketing page (one `index.html`,
  no build step). Preview with `just landing`.
- [sandbox/](./sandbox/README.md) - Slime v0 prototype (Node 22, TypeScript,
  Hono, Postgres, Claude, QuickJS) and its speed/correctness benchmark.
  Frozen: new engine work goes into `oss/packages/core/`.
- [oss/packages/core/](./oss/packages/core/README.md) - `@slime-cloud/core`,
  the engine rebuilt from `sandbox/` as an installable library. Design phase:
  [PLAN.md](./oss/packages/core/PLAN.md) holds the decisions and milestones.
  No code yet.
- `docs/` (no contract file; documentation only)
  - [architecture-spec.md](./docs/architecture-spec.md) - Development spec for
    the Slime runtime: request path, DB API, Gatekeeper rules, and Gas / Liquid
    / Crystal trust levels.
  - [architecture.excalidraw](./docs/architecture.excalidraw) - Architecture
    diagram matching the spec.
  - [slime_runtime_master_spec.md](./docs/slime_runtime_master_spec.md) -
    Vision pitch and target architecture (request-time synthesis, V8/Wasm,
    Redis, connectors). Broader than, and in places conflicting with, the
    development spec above.
  - `docs/brand/` - Brand and marketing material:
    - [slime_master_brand_book_agent_design_system.md](./docs/brand/slime_master_brand_book_agent_design_system.md) - Color tokens, typography, and UI rules for agents generating Slime UI.
    - [slime_master_brand_book_design_system.html](./docs/brand/slime_master_brand_book_design_system.html) - Interactive brand book and component kit.
    - [slime_marketing_positioning_tone_of_voice_use_cases.md](./docs/brand/slime_marketing_positioning_tone_of_voice_use_cases.md) - Positioning, tone of voice, use cases, and messaging.
- `.github/workflows/` (no contract file) - [ci.yml](./.github/workflows/ci.yml)
  runs pre-commit, sandbox tests and the Lambda bundle build on every push and
  pull request; [terraform.yml](./.github/workflows/terraform.yml) plans every
  `infra/aws/` stack on pull requests and applies them on `main` (the landing
  page included); [terraform-quality.yml](./.github/workflows/terraform-quality.yml)
  runs tflint and trivy.
- [infra/aws/](./infra/aws/README.md) - Terraform: `bootstrap/` (human-applied
  roles, state bucket, budgets) and the CI-applied stacks (`platform/`: Slime
  runtime on Lambda + DynamoDB).
- [slime-cloud/runtime/](./slime-cloud/runtime/README.md) - `@slime-cloud/runtime`:
  the Lambda entry and DynamoDB handler store around the core. Imports
  `sandbox/` (the future open-source `@slime-cloud/core`); `sandbox/` never
  imports it.
- [slime-cloud/provisioner/](./slime-cloud/provisioner) - `slime-provisioner`
  Lambda: turns `pending` endpoints in `slime-control` into `slime-ep-<id>`
  functions on the shared Gas layer, and deletes them again.
- [slime-cloud/admin/](./slime-cloud/admin) - slime cloud admin (Next.js, runs
  locally): sign-up, endpoints, usage board, OpenTelemetry. Design:
  [docs/slime-cloud/architecture.html](./docs/slime-cloud/architecture.html).

Root files: [AGENTS.md](./AGENTS.md) (repository contract for agents),
[justfile](./justfile) (task runner), and
[.pre-commit-config.yaml](./.pre-commit-config.yaml) (hooks).

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
  `infra/aws/` stack except `bootstrap/` on each push to `main` that touches
  `infra/aws/`, `sandbox/`, `slime-cloud/` or `landing/` (AWS account `025772230981`,
  `eu-central-1`); `landing/` is served by CloudFront + Lambda.

## System Verification

- Run: `just check` (runs `pre-commit run --all-files`; there is no test
  suite yet)
- Install hooks once per clone: `just hooks`
