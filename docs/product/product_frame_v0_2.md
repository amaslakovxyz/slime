# Slime Product Frame v0.2: devtool, slime-cloud, slime-client

* **Date:** 2026-11-21
* **Status:** Design (decisions taken with Tony; needs team review — touches the
  open "two v0 plans" question from [concepts_brief.md](concepts_brief.md))
* **Supersedes nothing yet.** This reframes how the existing engine is
  packaged and sold; the engine itself (`core/`) stays.

## Thesis

A client's agent sends an intent — Slime compiles it into a reviewed, pinned
API handler. The first call generates code with a background review (~1–2 s);
every repeat call runs deterministic code in milliseconds with zero model
tokens. **Intent once → pinned API.** The client writes no backend; Slime owns
the infra, the backend, and the integrations.

## The three components

### 1. `slime` — the builder's devtool

Installed on the workstation of whoever owns the data and integrations.
It is the dev-side of the existing core:

* declares what is exposed (which sources, which tables/scopes, which limits);
* inspects generated handlers and their review verdicts;
* pins contracts at build time (`slime warm` → a manifest of
  `expect`/`contractId` entries, "pinned by construction" per Dispatch
  Protocol v1).

Base: `@slime-cloud/core` as it exists on `main` (Node + Postgres,
Gas → Liquid → Crystal). From Tony's architecture-spec we adopt the
*build-time pinning idea* (dev pins intents; production refuses drift), not
the Bun/SQLite stack.

### 2. `slime-cloud` — the hosted platform

Runs the core plus the integration layer. Holds tenant credentials, the
handler cache, the background reviewer, and the tier lifecycle.

Integrations: **Linear first**, Postgres already works (it is the second
source on the "any backend" slide for free). Notion/Jira/HubSpot follow the
same pattern later.

The key mechanism that makes a SaaS API fit the existing engine: a
**virtual schema**. For Linear it is built from two parts: the GraphQL type
system (introspection, pruned to the types we expose) plus a snapshot of the
tenant's workspace structure (teams, projects, workflow states — data, not
introspection). The snapshot is hashed, and that hash plays the role the
Postgres schema hash plays today in the cache key and in `SCHEMA_STALE`
detection. Invalidation granularity is an open spike question: hashing the
full type system would invalidate every handler whenever Linear ships any
API change, so the hash must cover only the exposed subset. Generated
handlers emit GraphQL queries instead of SQL; the same review/promotion
pipeline applies.

### 3. `slime-client` — the consumer's devtool

The tool through which the *client's agent* works with data. Externally it
presents as an **MCP server**, so any agent connects with no new protocol to
adopt. Internally it translates calls into the Dispatch Protocol v1 envelope
(`{intent, input, output}` + optional `expect` with a 24-hex `contractId`).

Positioning answer to "why not just MCP?": with plain MCP the agent re-derives
a tool-call chain on every run — tokens, seconds, non-determinism. Slime is a
*compiler on top of MCP*: the intent is resolved once, the handler is
reviewed and pinned, repeats are deterministic code with zero model tokens.
Repeat latency is 3–8 ms against the local database (measured); against a
SaaS source it is bounded by the upstream API round-trip — the win there is
determinism and token cost, not raw milliseconds. Do not quote "3–8 ms" for
the Linear path in the pitch.

## Decisions taken (2026-11-21, with Tony)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Base architecture | `main` (concepts_brief) + build-time pins from Tony's spec | Least rework; the live-generation demo moment survives; pinning gives the production-safety story |
| 2 | First integration | Linear | GraphQL introspection gives a virtual schema almost for free; typed API is easier for the generator; Postgres stays as source #2 |
| 3 | slime-client protocol | MCP facade over Dispatch Protocol v1 | Zero-adoption for agents; keeps the researched envelope/contract design underneath |
| 4 | Writes in the demo | Read-only | The entire proven safety model is read-only; SaaS writes have no rollback; writes become a roadmap slide pointing at the Gatekeeper design |

## Demo vertical (hackathon scope)

1. An agent, through slime-client (MCP), asks: "my open Linear issues with
   estimates, grouped by cycle" → live generation against Linear (~1–2 s),
   `meta` shows the generated query and review status.
2. The same intent again → cached handler, milliseconds, zero tokens.
3. The same agent, same protocol, asks a question answered from Postgres —
   the "any backend, one protocol" slide, using the engine that already
   passes the benchmark.

Single tenant, hardcoded tokens. Say so out loud in the pitch; do not claim
multi-tenant.

## Primary technical risk — prototype first

The Linear virtual schema and GraphQL-emitting handlers are the only unproven
piece. Everything else (engine, cache, review, tiers, AWS runtime) exists and
is measured. Spike this on day 1, before any further infrastructure:
introspect → snapshot/hash → generate one read query → validate shape →
cache → repeat-call hit.

## Open questions (named, not blocking the demo)

* The six Dispatch Protocol v1 questions from the 2026-11-20 research run
  (value-leak false positives, `not_pinnable` strictness, `expectCode` vs
  Crystal rewrites, pagination beyond rowCap, `SCHEMA_STALE` recovery,
  deferred `INTENT_AMBIGUOUS`). The full research record is an internal
  artifact (not in the repo); ask Tony for access.
* Source addressing in the envelope: v0.2 routes by intent; an explicit
  source field is a later protocol revision.
* Writes: the only existing design is the Gatekeeper + invariants spec
  ([../architecture/architecture-spec.md](../architecture/architecture-spec.md)),
  written for SQLite transactions. SaaS writes (no rollback) need their own
  design: operation allowlist, confirm step, compensation log.
* Tenancy: secret store, per-tenant handler caches (two tenants' "my open
  issues" are different workspaces → different schema hashes → different
  handlers).
* OAuth-scope coarseness: a Notion/Linear scope cannot hide a single column
  the way `slime_reader` grants can; the per-source boundary model needs its
  own statement per integration.

## What this frame must not claim

Carried over from the brief's "claims the pitch must not make", plus:
"works with any integration" (one is built), "multi-tenant", "agent-safe
writes". Honest line: *"Read-only. One protocol for your database and your
SaaS tools. First call ~1–2 s with a review; repeats in milliseconds with
zero tokens, and you can inspect the generated query."*
