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

- [sandbox/](./sandbox/README.md) - Slime v0 prototype (Node 22, TypeScript,
  Hono, Postgres, Claude, QuickJS) and its speed/correctness benchmark.
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
  runs the pre-commit job on every push and pull request.

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

## System Verification

- Run: `just check` (runs `pre-commit run --all-files`; there is no test
  suite yet)
- Install hooks once per clone: `just hooks`
