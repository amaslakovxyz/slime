# Slime for coding agents: integrations research

* **Status:** Design (brainstorm in progress, not a contract)
* **Date:** 2026-11-21
* **Author:** @Tony (with an agent)

## 1. The reframe

Today `main` is a self-building backend for frontends: an app sends
`{intent, input, output}` and `@slime-cloud/core` generates and caches a
read-only SQL handler against one Postgres
([request format](../../core/docs/request-format.md)).

The proposed product changes three things:

* **Client:** the developer's coding agent (Claude Code, Cursor, Codex) talks
  to Slime through **slime-client**, a devtool installed on the developer's
  machine.
* **Sources:** **slime-cloud** connects integrations. The first narrow set is
  Linear, Notion and a database; later anything (Jira, HubSpot, ...).
* **Scope of ownership:** Slime turns what the client sends into an API and
  returns the answer. Slime owns the infrastructure, backend and integrations.

## 2. Decisions taken so far

| # | Question | Decision | Rejected alternatives |
|---|---|---|---|
| D1 | When does the agent use Slime? | **Hybrid explore → pin.** The agent explores data (Gas), pins a good request into a hosted endpoint (Liquid), and can export it into its repo as code (Crystal). | Runtime gateway only (competes head-on with MCP servers, Composio); dev-time API builder only (integrations become just more sources). |
| D2 | How are Linear/Notion queried? | **Live federation.** Every call goes to the source API at request time. | Sync → Postgres (excluded by D3: a replica is stored customer data). |
| D3 | Customer data retention | **No customer data is stored.** Rows and content live in memory for one request only. | Response caching, replicas. |
| D4 | Operations in v0 | **Read-only.** Matches `core` and the current positioning. | Writes; read + one confirmed write. |
| D5 | Where does execution run? | **All in slime-cloud** (tokens and execution in our Lambda). | Execution in slime-client (control/data plane split); explore local + pinned in cloud. |
| D6 | Agent-facing surface | **MCP server + `slime` CLI.** CLI: `login`, `connect`, `pin`. MCP tools: `query`, `catalog`, `pin`. Internally the existing `{intent, input, output}`. | Own protocol + SDK; CLI only. |

The hybrid maps the existing tiers onto user actions:

```mermaid
flowchart LR
  A[Coding agent] -->|MCP: intent + output| C[slime-client]
  C --> S[slime-cloud]
  S --> L[Linear] & N[Notion] & D[(Database)]
  S -->|Gas: answer now| A
  A -->|pin| S
  S -->|Liquid: hosted endpoint + typed SDK| App[Customer app]
  S -->|Crystal: code in repo| Repo[(Git)]
```

## 3. Research: live federation

### 3.1 What carries over from `core`

* The model already never sees rows or input values, only the dictionary,
  intent, input key names and `output` ([PLAN.md](../../core/PLAN.md) §4.5).
  "The model sees schema, not data" carries over unchanged and supports D3.
* The QuickJS shaping sandbox in a killable worker (`core/src/sandbox`) can be
  reused for joins and shaping in memory.
* What changes is what the model generates: a plan of source calls instead of
  one SQL query.

### 3.2 Handler shape: free JS vs declarative plan

| | L1. Free JS | **L2. Declarative plan (recommended)** |
|---|---|---|
| Model output | JS that calls `linear.graphql()`, `notion.query()` itself | A list of native source queries (Linear GraphQL, Notion filter JSON, SQL) plus JS that joins and shapes the results in memory |
| Pre-run checks | Nearly impossible: loops and calls happen at runtime | GraphQL validated against Linear's schema, Notion filters against data source properties, call count known up front, read/write visible statically |
| Relation to `core` | A new engine | Generalizes today's `SQL + shapeJs` into `sourceQueries[] + shapeJs` |

L2 keeps what the benchmark proved: generated code is checkable, reviewable
and cacheable ([concepts brief](concepts_brief.md)).

### 3.3 Source API limits (from the official docs, read 2026-11-21)

* **Linear** ([rate limiting](https://linear.app/developers/rate-limiting)):
  * requests: 2,500/hour per user with an API key, 5,000/hour per user for an
    OAuth app, 600/hour per IP unauthenticated;
  * complexity: 3,000,000 points/hour with an API key, 2,000,000 for an OAuth
    app;
  * pagination returns 50 records by default; children multiply complexity;
  * Linear discourages polling and recommends webhooks.
* **Notion** ([request limits](https://developers.notion.com/reference/request-limits)):
  * per connection: 180 requests/minute (600 on Business and Enterprise);
  * querying a data source: about 3 requests/second per connection;
  * a separate per-workspace limit is shared by all connections, so a 429 can
    arrive while one connection is under its own limit.

### 3.4 Consequences

1. **N+1 is the main enemy of cross-source joins.** "50 Linear issues → one
   Notion page each" at 3 rps takes about 17 s. Plans must batch where the
   API allows it: `issues(filter: { id: { in: [...] } })` in Linear, one
   data source query with an `or` filter in Notion when the pages live in a
   database and match on a property. Notion has no batch page retrieval, so
   joins on loose page links stay N calls. The validator rejects calls inside
   loops and caps fan-out.
2. **Liquid is no longer milliseconds.** No model on the request path, but
   every call still hits source APIs: an estimated 0.3–2 s (not measured).
   The benchmark's
   3–8 ms does not transfer; positioning and the demo must say so.
3. **Quota is our problem.** Slime spends the user's Linear quota. Needed: a
   per-handler call budget, 429 handling with `Retry-After`, and call cost in
   `meta`.
4. **Schema drift is cheap to detect.** A source schema fingerprint goes into
   the handler key. A renamed Notion property fails plan validation before any
   call and drops the handler back to Gas.

### 3.5 What "no customer data" means precisely (D3)

Stored:

* handlers (plans and shaping code);
* source schemas (Notion database and property names are customer metadata);
* OAuth tokens, encrypted with KMS;
* logs without payloads.

Never stored, not even as a response cache: rows and content.

### 3.6 Consequences of D5 (all in cloud)

* The customer database must be reachable from the internet: managed Postgres
  (Neon, Supabase, RDS) with an allowlist of our egress IPs. `localhost`
  databases are out of scope for v0.
* Data passes through our Lambda in transit and in memory only: never to disk,
  never to logs.

## 4. Gaps still to design

1. **Handler matching for agents.** The cache key is the normalized intent
   text. Agents paraphrase constantly, so every paraphrase is a new handler,
   model call and review, and Liquid rarely forms. Options: a handler
   **catalog** that slime-client exposes so the agent reuses existing intents,
   and/or semantic intent matching.
2. **Identity and permissions.** Whose token reads Linear: the developer's or a
   workspace's? A pinned production endpoint needs a service identity, scopes
   and token refresh. The rule "never take authorization from `input`"
   (request format) moves to the cloud layer.
3. **Semantic layer across sources.** Business terms ("customer", "blocked",
   "sprint") need a dictionary (`core`'s startup dictionary, PLAN.md §4.4)
   plus entity mapping across sources (Linear issue ↔ Notion page by link or
   id).
4. **Trust in answers.** The agent cannot verify a plan. Return `assumptions`
   and provenance (which source and fields), and mark Gas answers as
   unreviewed.
5. **Economics and metering.** Generation cost (model) differs from request
   cost (source calls). Needed: a per-tenant generation cap and a visible cost
   of a pin.
6. **DX path.** `slime login` → `slime connect linear` → MCP registered → first
   answer, plus a dashboard of handlers (plan, tier, cost, review state).
7. **ICP and demo.** Who pays: the solo vibecoder or a team with a BFF ticket
   queue? Proposed demo: an agent in Cursor asks in one request for "Linear
   issues blocking the release plus their Notion specs", pins it, and gets an
   endpoint for a dashboard.

## 5. Next decision

Handler matching (gap 1): catalog-first, semantic matching, or both.
