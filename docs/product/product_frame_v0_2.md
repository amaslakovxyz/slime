# Slime Product Frame v0.2 (unified): slime-client + slime-cloud

* **Date:** 2026-11-21 (unified same day from two parallel research tracks)
* **Status:** Design — the single frame going forward. Merges this track
  (three-component frame) with
  [2026-11-21-agent-integrations-research.md](2026-11-21-agent-integrations-research.md)
  (D1–D7 and the federation research; now a Record behind this doc).
* **Engine:** `@slime-cloud/core` on `main` stays the base; this reframes how
  it is packaged and sold.

## Thesis

A developer's coding agent (Claude Code, Cursor, Codex) sends an intent —
Slime compiles it into a reviewed, pinned API handler over the developer's
real sources (Linear, Notion, a database). First call generates with a
background review; a pinned call runs deterministic code with zero model
tokens and can never reach the generator. **Intent once → pinned API.** The
client writes no backend; Slime owns the infra, backend, and integrations.

## The two components

### `slime-client` — the developer's devtool (the only one)

One devtool on the developer's machine; the builder/consumer persona split
is roadmap, not v0. Two faces:

* **`slime` CLI:** `login`, `connect <source>`, `pin`.
* **MCP server** for the agent: tools `query`, `catalog`, `pin`. Internally
  every call is the Dispatch Protocol v1 envelope
  (`{intent, input, output}` + optional `expect`).

### `slime-cloud` — the hosted platform

Runs the core, the integration layer, tokens and execution (all in cloud —
the customer database must be internet-reachable; `localhost` is out of
scope for v0). Holds handlers, source schema fingerprints, encrypted OAuth
tokens, and logs without payloads. **Never stores rows or content — not even
as a response cache** (live federation: every call hits the source API at
request time).

Per source, a schema fingerprint plays the role the Postgres schema hash
plays today — in the cache key and in stale-schema detection, so a renamed
property fails validation before any call. What exactly goes into the
Linear fingerprint (and its invalidation granularity) is decided by the
day-1 spike, not here.

## Decisions (merged 2026-11-21, Tony; quiz-resolved where tracks diverged)

| # | Decision | Choice |
|---|---|---|
| 1 | Base architecture | `main` core + build-time pinning; Bun/SQLite spec stays a design record |
| 2 | Usage model | Hybrid **explore → pin**: agent explores (Gas), then an **explicit `pin`** plus a passing background review promotes the handler to a hosted endpoint (Liquid). No auto-promotion |
| 3 | Source access | Live federation; **no customer data stored** (handlers, schemas, tokens, payload-free logs only) |
| 4 | Operations | Read-only v0; writes are roadmap (SaaS writes have no rollback — needs its own design) |
| 5 | Reuse mechanics | **Both, phase-split:** `catalog` for explore; `expect`/`contractId` mandatory on pinned endpoints |
| 6 | State naming (2026-11-21 quiz) | **One state model: Gas → Liquid → Crystal.** Liquid = reviewed, pinned handler behind a hosted endpoint (identified by `contractId`); Crystal = the handler's code exported into the client's repo via `slime export` — roadmap, not v0. The engine's internal git-tier stays unnamed in product language. Static-host consumption: [crystal_static_host.md](crystal_static_host.md) |
| 7 | Integration scope | **Core line: Linear + Postgres. Stretch: Notion** with the cross-source join as the demo finale. Fallback is explicit: Notion is cut first |

Rejected alternatives and the full federation research (rate limits, N+1
math, the precise meaning of "no customer data") live in the
[research record](2026-11-21-agent-integrations-research.md).

## Reuse: how catalog and expect fit together

The cache key is the exact normalized intent text; agents paraphrase, and
every paraphrase would be a new generation. Two mechanisms for two phases:

* **Explore:** the agent calls `catalog` first — it lists only reviewed
  handlers (intent text, input types, output shape, sources, call cost,
  `contractId`) and the agent resends a listed intent verbatim for an exact
  cache hit. Known limit: depends on the agent following instructions;
  semantic matching stays a later option if the measured hit rate is low.
* **Pinned:** a production caller sends `expect: <contractId>`, and such a
  call can never reach the generator — a miss is an explicit error, never a
  silent regeneration. The mechanics (contractId derivation, the error
  split, the build-time pin manifest) are Dispatch Protocol v1; see the
  research record and the 2026-11-20 protocol artifact.

## Demo vertical (hackathon scope)

Core line (must work):

1. Agent in the editor asks Linear through slime-client → live generation,
   `meta` shows the generated query and review status.
2. The same intent again → cached handler, zero tokens.
3. Same protocol, a Postgres question — "any backend, one protocol", on the
   engine that already passes the benchmark.
4. `pin` → a hosted endpoint a dashboard can call with `expect`.

Stretch finale: "Linear issues blocking the release plus their Notion
specs" — one cross-source join. Hard constraint from review: the
Linear↔Notion link must be a property in a Notion database (one query with
an `or` filter); joins over loose page links are N calls at ~3 rps (~17 s
for 50 issues) and are not demoable.

Single tenant, hardcoded tokens. Say so in the pitch; do not claim
multi-tenant.

## Open questions

* **Handler shape (deferred by decision):** declarative plan
  (`sourceQueries[] + shapeJs`, statically checkable, generalizes today's
  `SQL + shapeJs`) vs per-source single query. The research record
  recommends the declarative plan; decide before the integration spike
  hardens an interface.
* **Identity (next decision per the research record):** whose token reads
  Linear/Notion in explore vs in a pinned endpoint; service identity,
  scopes, refresh.
* The Dispatch Protocol v1 open questions (six, from the 2026-11-20
  research run) live with the protocol: research record + internal
  artifact, ask Tony.
* Source addressing in the envelope (v0 routes by intent), quota budgeting
  per handler (429 + `Retry-After`, call cost in `meta`), semantic layer
  across sources, economics/metering, tenancy.

## Primary technical risk — prototype first

The Linear virtual schema and generated source queries are the only unproven
mechanism. Day-1 spike, before any infra: introspect → prune/hash → generate
one read query → validate shape → cache → repeat-call hit → `pin` →
`expect` call.

## What this frame must not claim

Carried from the concepts brief, plus: "works with any integration" (one or
two are built), "multi-tenant", "agent-safe writes", and any millisecond
latency for federated calls — repeat latency against SaaS sources is bounded
by the upstream API round-trip (estimated 0.3–2 s, not measured); 3–8 ms
holds only for the local database path. Honest line: *"Read-only. One
protocol for your database and your SaaS tools. First call generates with a
review; pinned calls are deterministic, token-free, and can never silently
regenerate."*
