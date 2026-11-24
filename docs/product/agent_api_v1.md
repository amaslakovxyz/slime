# Agent API v1 — headless Slime for autonomous agents

Status: Design (proposed, not on main). Rebased onto `main` at `5942965`
(first written as PR #30 on the PR #29 local build). Every route, field and
error code below is marked **shipped** (on main today, with the code that
answers it) or **proposed** (this design). The machine-readable form is
[agent_api_v1.openapi.yaml](agent_api_v1.openapi.yaml), where each operation
carries `x-status: shipped | proposed`.

Derived from a full customer-journey run (2026-11-21): the only steps that
forced a browser were sign-up, "Reveal token", and the Crystallize button.
They still do on main: the admin has no HTTP API, only Next.js server actions.
This spec removes those three, and nothing else.

## Premise

The customer of Slime is a coding agent, not a person. The current flow is
agent-shaped in the data plane (`/v0/query` is already perfect for an agent)
but human-shaped in the control plane: the token lives behind a UI click and
the Gas → Liquid → Crystal lifecycle ends at a button only a human can press.

This spec makes the whole journey — connect, query, mature, crystallize —
possible with curl alone, under one standing assumption:

> **Approvals are delegated to the agent.** Crystallization does not wait for
> a human. The gate is replaced by hard mechanical criteria (run count +
> replay check), not by judgment. A human can still watch, and can flip the
> policy back to manual, but the default for this API is autonomous.

The admin UI stays as the human's window: same state, read from the same
store. It stops being a mandatory step of the machine path.

## Design rules

1. **One token end to end.** After bootstrap the agent holds a single `slm_`
   key and never needs another credential to finish the lifecycle. Crystal
   tokens (`slc_`) remain what they are today: scoped *down*, one per
   Crystal, for handing to narrower consumers.
2. **Every answer teaches the next step.** Responses carry the lifecycle
   position (`runs`, thresholds, `readyToCrystallize`) so the agent never
   polls a web page or counts calls on its side.
3. **Client mistakes are 4xx with the fix inside.** Missing input → the
   expected-input list as fields, not only prose (the crystal route already
   names the inputs in `message`). Reworded intent → the nearest existing
   intents, so agents reuse handlers instead of minting Gas duplicates.
4. **Nothing in the data path changes.** `/v0/query` and `/v0/e/<key>`
   keep their request/response shapes; `meta` and the error body only gain
   fields.

## Base URLs

Routes are the endpoint's own paths (`platform/runtime/src/app.ts`):

- **Slime Cloud:** `https://<runtime host>/ep/<endpointId>/`, `endpointId`
  matching `^ep-[0-9a-f]{10}$` (`platform/runtime/src/lambda.ts`,
  `src/tenants.ts:28`; Contract 1 of
  [the cloud MVP design](../architecture/2026-11-21-cloud-mvp-design.md)).
- **Local:** `http://localhost:<port>/`, one process per endpoint, ports from
  8700 (`platform/admin/scripts/local-runner.ts`).

The admin shows the endpoint URL with a trailing `/`; routes are joined
onto it (`<url>v0/query`). The `/v1/*` control-plane routes have no host
today: they are proposed, and the admin would serve them.

## Surface — six routes

| # | Route | Auth | Status | Purpose |
|---|-------|------|--------|---------|
| 0 | `POST /v1/accounts` | none (local/dev only) | proposed | create account → `sla_` key, shown once |
| 1 | `POST /v1/endpoints` | `sla_` | proposed | create endpoint → `endpointId`, `url`, `slm_` token shown once |
| 2 | `POST /v0/query` | `slm_` | shipped; `meta` additions proposed | dispatch, `meta` enriched |
| 3 | `GET /v0/lifecycle` | `slm_` | shipped; endpoint-level fields proposed | machine-readable endpoint + handler state |
| 4 | `POST /v0/handlers/{handlerKey}/crystallize` | `slm_` | proposed | promote one proven handler; `slc_` token shown once |
| 5 | `POST /v0/e/{handlerKey}` | `slc_` or `slm_` | shipped; error fields proposed | crystal route |

Shipped alongside route 4: `POST /v0/crystallize` with `{keys?}` (`slm_`),
the batch job the Crystallize button calls today (section 4).

Other shipped routes, outside this spec (all behind `slm_`):
`GET /healthz` (`?fresh=1` on Lambda), `GET /v0/handlers`,
`DELETE /v0/handlers/<key>`, `GET /v0/events?limit=&before=&after=`,
`POST /v0/reload` (`app.ts`, `lambda.ts`, `local.ts`; table in
[platform/runtime/README.md](../../platform/runtime/README.md#routes)).

Nothing else is new — no update/delete/list surface in v1; the UI keeps
those.

### 0. Bootstrap an account (local/dev) — proposed

```
POST /v1/accounts
{ "email": "agent@slime.local", "password": "…" }

201 { "accountId": "ac_…", "key": "sla_…" }        # key shown once
409 ACCOUNT_EXISTS
```

Exists so a fresh checkout is usable headlessly. Hosted deployments may
disable it and hand out `sla_` keys from the UI instead. Today sign-up is a
form in the admin and `sla_` keys do not exist.

### 1. Create an endpoint — proposed

```
POST /v1/endpoints            x-api-key: sla_…
{ "name": "revenue-dash", "provider": "claude",
  "databaseUrl": "postgres://…" }

201 {
  "endpointId": "ep-0123456789",
  "url": "https://<runtime host>/ep/ep-0123456789/",   # local: http://localhost:8704/
  "token": "slm_…",                                    # shown once
  "status": "provisioning",                            # local: "pending"
  "policy": { "crystallize": "auto" }
}
```

`provider` is one of main's two, `claude` or `groq`
(`platform/runtime/src/config.ts`); the offline provider of the
2026-11-21 build was removed in #40. Creation is async as in the admin today:
the endpoint starts `provisioning` (cloud) or `pending` (local) and becomes
`ready` or `failed` (`platform/admin/lib/endpoints.ts`, `STATUSES`). Until
the endpoint has settings the runtime answers `404 ENDPOINT_NOT_FOUND`, and
`503 NOT_READY` while its engine cannot start; the agent polls
`GET <url>healthz` (shipped, 200 when ready) or route 3.
`policy.crystallize` is `"auto"` by default per the premise above;
`"manual"` restores today's human gate.

### 2. Query — enriched `meta`

Request unchanged (shipped, [core/docs/request-format.md](../../core/docs/request-format.md)):
`intent` and `output` required, `input` optional, unknown fields refused
with `400 INVALID_REQUEST`, bodies above 16 KB refused with
`413 INVALID_REQUEST`.

Shipped `meta`: `handlerKey`, `tier` (`gas | liquid | crystal`), `cache`
(`miss | hit | coalesced`), `truncated`, `timingsMs`, `attempts` (on a miss), `warnings`, `review`
(`none | pending | approved | rejected`), and `sql`, `shapeJs`,
`assumptions`, `steps` when present (`core/src/engine/types.ts`). Proposed
additions carry the lifecycle position:

```json
"meta": {
  "handlerKey": "d38184…",
  "tier": "liquid",
  "cache": "hit",
  "runs": 7,
  "thresholds": { "liquidRuns": 3, "crystalRuns": 10 },
  "readyToCrystallize": false
}
```

`thresholds` uses the names `/v0/lifecycle` already returns (defaults 3
and 10: `GAS_TO_LIQUID_HITS`, `CRYSTAL_MIN_RUNS`). `readyToCrystallize` is
the admin's existing rule: tier `liquid`, not stale, `runs ≥ crystalRuns`
(`platform/admin/lib/lifecycle.ts`, `toRow`). The agent that wants a crystal
keeps calling until `readyToCrystallize: true`, then calls route 4. No UI, no
guesswork.

Error contract (proposed, this route):

- **Missing input on a known intent.** Today there is no such case on this
  route: input *names* are part of the handler key
  (`core/src/request/key.ts:33`; "leaving a name out is a different
  request", `core/docs/request-format.md`), so a request that leaves out
  `limit` misses the existing handler and is generated as a new one. That
  succeeds as a new Gas handler (`cache: "miss"`), or, when the generated
  SQL still maps a parameter to the absent name and the repair also fails,
  ends in `500 INVALID_HANDLER` (`core/src/artifact/checks/sql.ts:38`,
  `core/src/engine/generation/generate.ts:62-80`). The 2026-11-21 run saw
  the 500 every time because its offline provider returned a fixed handler
  regardless of input names. Proposed: when a handler with the same
  normalized intent and `output` takes other input names, answer
  **400 `INVALID_REQUEST`** with `"expected": { "limit": "number" },
  "missing": ["limit"]` instead of generating a near-duplicate — the crystal
  route's wording is the model. This is a behaviour change (refuse instead of
  generate) and needs that decision.
- **Reworded intent.** On main a new wording is a new key and is generated
  (`cache: "miss"`), a Gas duplicate; `422 INTENT_UNSATISFIABLE` comes only
  when the model finds the database cannot answer. Proposed: that 422 carries
  `"nearest": ["top N accounts by total paid invoice amount in cents, highest
  first"]`, so the agent repairs its wording and reuses the existing handler.
  Since a reworded intent is generated rather than refused, `nearest` on 422
  alone no longer catches most duplicates; whether a `miss` should carry it
  too is open.

### 3. Lifecycle — the agent's dashboard

Shipped (`app.ts` `GET /v0/lifecycle`, rows merged by `mergeHandlers`; read
by the admin as `RuntimeHandler` in `platform/admin/lib/lifecycle.ts`):

```
GET /v0/lifecycle             x-api-key: slm_…

200 {
  "handlers": [
    { "key": "d38184…",
      "intent": "top N accounts by total paid invoice amount in cents, highest first",
      "tier": "crystal",                  # gas | liquid | crystal
      "runs": 12,
      "review": "approved",               # optional
      "fixtures": 3,                      # optional
      "createdAt": "2026-11-22T…",        # optional
      "inputs": { "limit": "number" },    # Crystal only
      "stale": false }                    # optional; true = regenerates on next request
  ],
  "stats": { "handlers": { "gas": 0, "liquid": 1 },
             "generationsThisHour": 2, "generationsInFlight": 0 },
  "thresholds": { "liquidRuns": 3, "crystalRuns": 10 },
  "warnings": [],
  "instance": true                        # Lambda only: Gas rows are this instance's
}
```

Proposed additions:

```
  "endpointId": "ep-0123456789",
  "status": "ready",          # pending | provisioning | ready | failed | updating | deleting
  "policy": { "crystallize": "auto" },
  handlers[]: "readyToCrystallize": false,   # already crystal
              "route": "/v0/e/d38184…"       # present once crystal
```

One GET replaces badge-watching, row-reading and the 2-second page refresh.
The six statuses are the admin's (`STATUSES`); today they live only in the
admin's control table, so the runtime would have to read them. `updating` is
how the agent observes a local crystallization restart.

### 4. Crystallize — the approval, delegated

**Shipped:** `POST /v0/crystallize` (`app.ts`, `endpoint-runtime.ts`),
mounted whenever the endpoint has a Crystal store (always on Lambda, locally
with `SLIME_CRYSTAL_DIR`):

```
POST /v0/crystallize                      x-api-key: slm_…
{ "keys": ["d38184…"] }                   # optional; absent = every saved handler

200 { "reports": [
  { "key": "d38184…", "intent": "…",
    "outcome": "crystallized",            # crystallized | already | not-ready | skipped | failed
    "reasons": [] } ] }
```

The runtime does not issue tokens. The admin's Crystallize button calls this
route, then issues one `slc_` token per crystallized key into the endpoint's
`CRYSTAL_TOKENS` secret and delivers it: `POST /v0/reload` in the cloud, a
restart through `updating` locally (`platform/admin/app/actions.ts`,
`crystallizeAction`).

**Proposed:** one handler, one call, token in the answer:

```
POST /v0/handlers/d38184…/crystallize     x-api-key: slm_…
{}

201 {
  "handlerKey": "d38184…",
  "route": "/v0/e/d38184…",
  "token": "slc_…",                        # shown once
  "exampleBody": { "input": { "limit": 5 } }
}

409 CRYSTAL_NOT_READY { "runs": 7, "required": 10 }   # criteria not met
409 REVIEW_REQUIRED                                   # policy.crystallize = "manual"
200 (idempotent)     same body minus "token"          # already crystal
```

It wraps the shipped job for one key and moves token issuing from the admin
into the runtime, so the `slm_` holder gets the `slc_` token without the UI.
The 409 code is `CRYSTAL_NOT_READY`, not `NOT_READY`: on main `NOT_READY` is
the router's 503 for an engine that cannot start.

Autonomy does **not** weaken the gate — it mechanizes it. The server still
requires, regardless of policy: tier is liquid, `runs ≥ crystalRuns`, and the
replay check passes (the shipped job runs the candidate code on the
handler's recorded inputs and compares it with the Liquid handler's answers;
`crystal/src/equivalence.ts`).
`policy.crystallize` only decides *who* may pull the trigger: the agent
(`auto`) or a human in the UI (`manual`). What the button does in the UI and
what this route does are the same job; the UI button stays and simply
becomes optional.

Delivery behaves as shipped today: on Lambda the answering instance swaps its
engine at once and the others pick the Crystal up within their TTL; locally
the endpoint restarts on the same port and URL, its `status` passing through
`updating` back to `ready` (observable via route 3).

### 5. Crystal route

`POST /v0/e/<handlerKey>` with `{ "input": … }`, `slc_` or `slm_` key —
shipped (`app.ts`, `auth.ts`). The body must carry exactly the Crystal's
input names (`null` allowed). A missing or unknown name is
`400 INVALID_REQUEST`, the names only in `message`
("This endpoint takes input: limit (number). Missing: limit."); an unknown
key is `404 HANDLER_NOT_FOUND`; above 16 KB `413 INVALID_REQUEST`; an
`slc_` token opens only its own route and gets `401 UNAUTHORIZED` everywhere
else. Proposed: the 400 also carries `expected` and `missing` as fields. v1
adopts this error style as the standard for route 2.

## Error envelope (uniform)

Shipped: `{ "error": { "code", "message", "retryable", …details } }` from
core (`SlimeError.toJSON`, `core/src/shared/errors.ts`) and the runtime.
Details already appear for some codes, for example `enforcedBy` on
`WRITE_REFUSED`. Proposed fields:

```json
{ "error": {
    "code": "INVALID_REQUEST",
    "message": "This endpoint takes input: limit (number). Missing: limit.",
    "retryable": false,
    "expected": { "limit": "number" },     # proposed, when applicable
    "missing":  ["limit"],                 # proposed, when applicable
    "nearest":  ["…"]                      # proposed, 422 only
} }
```

Shipped codes:

| Code | Status | From |
|---|---|---|
| `INVALID_REQUEST` | 400 (413 above 16 KB) | core, runtime |
| `UNAUTHORIZED` | 401 | runtime |
| `WRITE_REFUSED`, `ACCESS_DENIED` | 403 | core |
| `HANDLER_NOT_FOUND` | 404 | core (crystal route) |
| `ENDPOINT_NOT_FOUND` | 404 | Lambda router |
| `NOT_FOUND` | 404 | runtime: a path or method the endpoint does not serve (since PR #59) |
| `INTENT_UNSATISFIABLE`, `QUERY_TOO_LARGE` | 422 | core |
| `GENERATION_RATE_LIMITED` | 429 | core |
| `SHAPE_MISMATCH`, `SANDBOX_ERROR`, `QUERY_ERROR`, `QUERY_TOO_EXPENSIVE`, `INVALID_HANDLER`, `INTERNAL` | 500 | core; `INTERNAL` runtime |
| `GENERATION_FAILED`, `SOURCE_ERROR` | 502 | core |
| `NOT_READY` | 503 | Lambda router |
| `GENERATION_TIMEOUT`, `EXECUTION_TIMEOUT` | 504 | core |

Proposed codes: `CRYSTAL_NOT_READY`, `REVIEW_REQUIRED`, `ACCOUNT_EXISTS`
(409). The first draft's `INVALID_INPUT` (400) maps onto the shipped
`INVALID_REQUEST`, which the crystal route already uses for a missing input,
plus the proposed `expected`/`missing` fields; its `PROVIDER_ERROR` (502)
maps onto the shipped `GENERATION_FAILED` (the model call failed).

5xx is meant for Slime's own failures; a malformed client request should
never be a 5xx. Main is close but not there: `INVALID_HANDLER` (500) is
still what a generation that cannot map an input ends in (section 2).
A path or method the endpoint does not serve answers `404 NOT_FOUND` inside
the envelope (PR #59; before it, a plain-text `404 Not Found`).

## Token model

| Prefix | Scope | Issued today | Issued in v1 (proposed) | Shown |
|--------|-------|--------------|-------------------------|-------|
| `sla_` | account control plane (`/v1/*`) | does not exist | route 0 / UI | once |
| `slm_` | one endpoint: every route | admin, at endpoint creation ("Reveal token") | route 1 | once |
| `slc_` | exactly one crystal route | admin, after Crystallize | route 4 | once |

Strictly descending privilege; every journey step needs only the narrowest
token that can perform it. Rotation/revocation stays in the UI for v1.

## Acceptance test

The whole journey from the 2026-11-21 e2e run — sign-up through using the
crystal as its own endpoint, 12 steps — must pass as **one bash script of
curl calls with zero browser launches**, against `SLIME_URL` set to the
endpoint URL without its trailing `/` (`https://<runtime host>/ep/<id>` or
`http://localhost:87xx`), calling `$SLIME_URL/v0/query`,
`$SLIME_URL/v0/lifecycle`, `$SLIME_URL/v0/handlers/<key>/crystallize` and
`$SLIME_URL/v0/e/<key>`. That script is the contract test for this spec;
today the same journey needs two Playwright scripts.

## Relation to product frame v0.2

This spec was first written against the PR #29 local build and inherits its
state mechanics; [product_frame_v0_2.md](product_frame_v0_2.md) — the
declared frame going forward — resolves some of them differently. The
divergence predates this spec; naming it here so the API does not read as a
competing model:

- **Route 4 is the API form of the frame's `pin`.** The frame already
  grants the explicit promotion action to "the client **or its Dev Agent**"
  (glossary: Pin; decision 2). This spec mechanizes exactly that action over
  HTTP; "no auto-promotion" is preserved — nothing promotes by run count
  alone, the agent must call the route.
- **"Crystal" means two things today.** In the build (and here): a handler
  promoted to its own hosted route. In the frame (decision 6): code
  *exported* into the client's repo — roadmap, not v0. If the frame's naming
  wins, route 4 renames to `/pin` and "crystal route" becomes the pinned
  endpoint; the surface of this API does not change, only the words.
- **The review slot.** The frame's background review is one more entry in
  the mechanical criteria list of route 4 (alongside run count and the
  replay check); `409 REVIEW_REQUIRED` already covers "review has not
  passed yet" as well as "policy is manual".

## Out of scope for v1

Endpoint update/delete, token rotation, reviewer workflows, usage/billing
reads, webhooks on tier change (the lifecycle GET covers polling; push can
come later), multi-endpoint listing. The UI keeps all of these.
