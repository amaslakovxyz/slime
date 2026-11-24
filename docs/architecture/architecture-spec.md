# Slime — Architecture Spec (dev)

**Date:** Nov 20, 2026 · **Author:** @Tony · **Status:** Superseded by [core/PLAN.md](../../core/PLAN.md) (kept as history; its implementation, `feat/shop-bench` and `chore/gas-v0-plan`, was never merged)

## Overview

Slime is a single Bun process that serves business intents through sandboxed, agent-generated handlers and never calls an LLM on the request path.

- **Source of truth:** human-written intent specs (`intents/*.md`) and human-accepted fixtures. Handler code is a regenerable cache.
- **Core rule:** handlers can only read through `db.read` and propose writes through `db.emit`; the kernel decides what commits.
- **Scope:** meetup ticketing hackathon build for 1–3 people over 24–48 hours (assumed, not confirmed).

## Architecture

Everything except the agent runs in one Bun process. In production, a request flows through `Dispatcher → Registry → Sandbox → Gatekeeper → Invariant runner → SQLite`, inside one transaction. Dashed/dev-only components are absent from the production request path.

### Components

| Module | Responsibility | Technology | Mode |
|---|---|---|---|
| Dispatcher | `POST /dispatch`; builds `ctx {tenantId, userId, role, now}` from the session; returns 404 for unknown intents | Bun HTTP server | dev + prod |
| Registry | Maps intent to the pinned handler hash from `slime.lock`; refuses unpinned code in prod | TypeScript | dev + prod |
| Sandbox runner | Runs one handler per call with memory limit and deadline; no host I/O | quickjs-emscripten (sync build) | dev + prod |
| DB API | `db.read` (declarative, tenant filter added) and `db.emit` (collects effects) | TypeScript over `bun:sqlite` | dev + prod |
| Gatekeeper | Validates every effect against the intent spec; rejects the whole set on any failure | TypeScript | dev + prod |
| Invariant runner | Applies effects in the open transaction; runs invariant `SELECT`s; commits only when all return zero rows | `bun:sqlite` | dev + prod |
| Build loop | Parses specs, builds prompts, calls the agent, dry-runs, records fixtures, writes `slime.lock` | TypeScript CLI (`slime`) | dev only |
| Agent | Writes handler source from spec and schema | Current Claude model via Anthropic API | dev only |
| Storage | Specs, fixtures, handlers and `slime.lock` in git; application data in one SQLite file | git + SQLite | — |

## Contracts

### Intent spec

Human-written at `intents/<name>.md`:

```yaml
roles: user
reads: events, promos, tickets
writes: tickets(insert)
rule: total = qty * event.price_cents. Valid promo => minus pct%, capped at 50%.
invariant sold_out: SELECT e.id FROM events e JOIN tickets t ON t.event_id=e.id
                    GROUP BY e.id HAVING SUM(t.qty) > e.capacity
try: {eventId: 7, qty: 2, promo: "FALL10"}
```

### Generated handler

Pure JavaScript executed in QuickJS:

```js
export function handler(input, db, ctx) -> { response, error? }
```

### DB API

These are the only host functions exposed to the sandbox:

```ts
db.read({ table, columns, where, limit })
// where is an equality map; the kernel adds tenant_id

db.emit({
  op: "insert" | "update" | "delete",
  table,
  data?,
  where?
}) // collected, not executed by the handler
```

### Development CLI

- `slime build [intent]` — generate, dry-run, and show effect diffs.
- `slime accept <intent>` — save shown diffs as fixtures.
- `slime test` — replay all fixtures against current handlers.
- `slime freeze` — write handler hashes to `slime.lock` and create a git commit.

## Flows

### Request path (dev and prod)

1. Dispatcher receives `{intent, payload}` and builds `ctx` from the server session.
2. Registry looks up the pinned hash; no match returns 404.
3. Kernel opens `BEGIN IMMEDIATE` on the real database.
4. Sandbox runs the handler; `db.read` uses the DB API inside the same transaction.
5. Gatekeeper validates collected effects; failure causes rollback and `403/422` with a reason code.
6. Invariant runner applies effects and runs invariants; any returned row causes rollback and `422`.
7. Commit and return the response with `{intent, handlerHash, effectsApplied}`.

The request path never reaches the agent. The build path never touches the real database.

### Build path (dev only)

1. `slime build` hashes the spec, schema, prompt version and model ID; an existing key skips generation.
2. The agent receives the spec, declared table schema and DB API contract and returns handler source (Gas).
3. The kernel copies the seed DB and runs each try input through request-path steps 3–6, always rolling back.
4. Failure returns a reason code to the agent for up to three rounds; then the build fails.
5. Success shows the effects diff; `slime accept` stores `{seed, input, ctx.now, effects}` as a fixture (Liquid).
6. `slime freeze` pins the exact bytes (Crystal).

## Trust levels and modes

Production runs only **Crystal**; all other levels remain in development.

| Level | Meaning | Runs against | Serves |
|---|---|---|---|
| Gas | Generated, unchecked | Seed DB copy, always rolled back | Nothing |
| Liquid | Passed Gatekeeper, invariants and accepted fixtures | Dev DB | Dev requests |
| Crystal | Exact bytes pinned in `slime.lock` by a human commit | Prod DB | Real traffic |

A spec edit marks that intent's fixtures stale and drops its handler to Gas. Regenerated code remains Liquid until re-frozen. `SLIME_MODE` is read only from the environment, never from a request. In production the agent module is not loaded, making LLM calls impossible.

## Gatekeeper rules

Every check is required; any failure rejects the complete effect set:

- `ctx.role` is declared in the spec.
- Reads and effects target declared tables, operations and columns.
- `tenant_id` is forced on inserts and added to every `where` clause.
- Updates and deletes address the full primary key using equality.
- Effect count is below a fixed cap.
- Forbidden columns are rejected, never silently filtered.

## Data model

All tables carry `tenant_id`; money is stored as integer cents.

| Table | Columns |
|---|---|
| `events` | `id`, `tenant_id`, `capacity`, `price_cents` |
| `tickets` | `id`, `tenant_id`, `event_id`, `user_id`, `qty`, `promo_code`, `total_cents` |
| `promos` | `code`, `tenant_id`, `pct`, `max_uses` |

## Non-goals and open questions

**Non-goals:** external DB side effects (payments, email, webhooks), joins or raw SQL in `db.read`, multi-instance deployment, and automatic promotion to Crystal.

- [ ] Team size, hours and judging criteria?
- [ ] Should `db.read` support `in` and range filters, or equality only?
- [ ] Is `cancel_ticket` in scope, or only `book_ticket` and `list_open_events`?

**Not measured:** LLM generation time per build round.
