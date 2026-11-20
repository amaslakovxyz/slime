# Liquid Engine — Architecture Spec (dev)

**Date:** Nov 20, 2026 · **Author:** @Tony · **Status:** Hackathon development spec

## Overview

Liquid Engine is a single Bun process that serves business intents through sandboxed, agent-generated handlers. On a handler-cache miss the handler is generated just-in-time on the request path; every handler — fresh or cached — runs through the same harness before anything commits.

- **Source of truth:** human-written intent specs (`intents/*.md`). Handler code is a regenerable cache; Liquid fixtures are recorded from harness-passing live runs, and only Crystal pins are human-committed.
- **Core rule:** handlers can only read through `db.read` and propose writes through `db.emit`; the kernel decides what commits.
- **Scope:** meetup ticketing hackathon build for 1–3 people over 24–48 hours (assumed, not confirmed).

## Architecture

Everything runs in one Bun process; the agent is called only on a handler-cache miss. A request flows through `Dispatcher → Registry (Crystal → Liquid → Gas cache; miss → Agent) → Sandbox → Gatekeeper → Invariant runner → SQLite`, inside one transaction.

### Components

| Module | Responsibility | Technology | Mode |
|---|---|---|---|
| Dispatcher | `POST /dispatch`; builds `ctx {tenantId, userId, role, now}` from the session; returns 404 for unknown intents | Bun HTTP server | dev + prod |
| Registry | Resolves intent to a handler: Crystal (`lee.lock`) → Liquid (`state/`, `handlers/`) → Gas (in-memory, sliding TTL); owns tier transitions | TypeScript | dev + prod |
| Sandbox runner | Runs one handler per call with memory limit and deadline; no host I/O. Isolated sandboxes for prod are planned. | quickjs-emscripten (sync build) | dev + prod |
| DB API | `db.read` (declarative, tenant filter added) and `db.emit` (collects effects) | TypeScript over `bun:sqlite` | dev + prod |
| Gatekeeper | Validates every effect against the intent spec; rejects the whole set on any failure | TypeScript | dev + prod |
| Invariant runner | Applies effects in the open transaction; runs invariant `SELECT`s; commits only when all return zero rows | `bun:sqlite` | dev + prod |
| Build loop | Manual path: parses specs, builds prompts, calls the agent, dry-runs `try` inputs on a seed copy, shows effect diffs; caches nothing | TypeScript CLI (`lee`) | dev |
| Agent | Writes handler source from spec, schema and DB API contract; called on a Registry miss (JIT) or by `lee build` | Current Claude model via Anthropic API | dev + prod |
| Storage | Specs, Liquid/Crystal handlers, fixtures, `state/` and `lee.lock` in git; Gas only in process memory; application data in one SQLite file | git + SQLite | — |

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

- `lee serve` — run the Dispatcher (`POST /dispatch`) with JIT generation.
- `lee build [intent]` — manual path: generate, dry-run, and show effect diffs; caches nothing.
- `lee accept <intent>` — save shown diffs as fixtures (planned).
- `lee test` — replay all fixtures against current handlers (planned).
- `lee freeze` — write handler hashes to `lee.lock` and create a git commit (planned).

## Flows

### Request path (dev and prod)

1. Dispatcher receives `POST /dispatch {intent, payload}`, builds `ctx` from the dev session.
2. Load intent (unknown → 404). Registry resolves Crystal → Liquid → Gas (a Gas hit bumps hits and slides the TTL).
3. **Hit** → harness on the real DB with commit. If the tier is Gas, a passing run is recorded as a fixture and may promote the handler. Return the result.
4. **Miss** → the build path's generate-with-repair (≤ 3 rounds, judged on the spec's `try` inputs against seed copies, reason codes fed back). Exhausted → 502, nothing cached. Success → harness on the real DB with commit for the live payload → pass: COMMIT, admit to Gas, 200; fail: rollback, 4xx, nothing cached.
   - Repair is judged on `try` inputs, never on the live payload: a live rejection (sold out, `BAD_QTY`) is business logic, not a code defect, and must not trigger regeneration.
   - The payload is never put into the prompt (no prompt injection from requests).
   - No transaction is held during the LLM call: generation finishes before the harness opens `BEGIN IMMEDIATE`.

The agent is reached only on a cache miss, and its output is verified on the spec's `try` inputs against a seed copy before it touches the real database.

### Build path (manual, dev)

1. The agent receives the spec, declared table schema and DB API contract and returns handler source (Gas).
2. The kernel copies the seed DB and runs each try input through the harness (role → sandbox → gatekeeper → invariants), always rolling back.
3. Failure returns a reason code to the agent for up to three rounds; then the build fails.
4. Success shows the effects diff; nothing is cached or committed.
5. `lee accept` / `lee freeze` (planned) record fixtures and pin bytes.

## Trust tiers

| Tier | Meaning | Lifetime | Serves |
|---|---|---|---|
| Gas | Generated just-in-time on a cache miss; passed the harness on the spec's `try` inputs and on the triggering request | In-memory, sliding TTL (default 10 min); evicted if not reused | Live traffic |
| Liquid | Gas handler reused ≥ 3 times with ≥ 3 harness-passing runs; those runs are recorded as fixtures | Persistent (`handlers/`, `fixtures/`, `state/`), no TTL | Live traffic |
| Crystal | Exact bytes pinned in `lee.lock` by a human commit | Persistent, pinned | Live traffic (highest precedence) |

Lookup order is Crystal → Liquid → Gas. A spec edit changes the spec hash: every tier recorded under the old hash is ignored (its fixtures are stale) and the next request regenerates into Gas. JIT generation is enabled in dev and prod. Promotion to Crystal is never automatic.

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
