# Agent API v1 — headless Slime for autonomous agents

Status: design proposal (research). Stacked on the Lifecycle work in PR #29.
Derived from a full customer-journey run of the current build (2026-11-21): the
only steps that forced a browser were sign-up, "Reveal token", and the
Crystallize button. This spec removes those three, and nothing else.

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
   tokens (`slc_`) remain what they are today: scoped *down*, issued at
   crystallization, for handing to narrower consumers.
2. **Every answer teaches the next step.** Responses carry the lifecycle
   position (`runs`, thresholds, `readyToCrystallize`) so the agent never
   polls a web page or counts calls on its side.
3. **Client mistakes are 4xx with the fix inside.** Missing input → the
   expected-input list (the crystal route already does this; the dispatch
   route must match it — today it answers 500). Unknown intent wording →
   the nearest existing intents, so agents reuse handlers instead of minting
   gas duplicates.
4. **Nothing in the data path changes.** `/v0/query` and `/v0/e/<hash>`
   keep their request/response shapes; `meta` only gains fields.

## Surface — six routes

| # | Route | Auth | Purpose |
|---|-------|------|---------|
| 0 | `POST /v1/accounts` | none (local/dev only) | create account → `sla_` key, shown once |
| 1 | `POST /v1/endpoints` | `sla_` | create endpoint → `endpointId`, `url`, `slm_` token shown once |
| 2 | `POST /v0/query` | `slm_` | dispatch (unchanged), `meta` enriched |
| 3 | `GET /v0/lifecycle` | `slm_` | machine-readable endpoint + handler state |
| 4 | `POST /v0/handlers/{handlerKey}/crystallize` | `slm_` | promote a proven handler; `slc_` token shown once |
| 5 | `POST /v0/e/{handlerKey}` | `slc_` or `slm_` | crystal route (unchanged) |

Routes 2 and 5 exist today as-is. Route 3 exists but is undocumented and
returns less than agents need. Routes 0, 1, 4 are new. Nothing else — no
update/delete/list surface in v1; the UI keeps those.

### 0. Bootstrap an account (local/dev)

```
POST /v1/accounts
{ "email": "agent@slime.local", "password": "…" }

201 { "accountId": "ac_…", "key": "sla_…" }        # key shown once
409 ACCOUNT_EXISTS
```

Exists so a fresh checkout is usable headlessly. Hosted deployments may
disable it and hand out `sla_` keys from the UI instead.

### 1. Create an endpoint

```
POST /v1/endpoints            x-api-key: sla_…
{ "name": "revenue-dash", "provider": "offline",
  "databaseUrl": "postgres://…" }

201 {
  "endpointId": "ep_…",
  "url": "http://localhost:8704/v0/query",
  "token": "slm_…",                                 # shown once
  "status": "pending",
  "policy": { "crystallize": "auto" }
}
```

Creation is async exactly as today (PENDING → READY); the agent polls
route 3 until `status: "ready"`. `policy.crystallize` is `"auto"` by default
per the premise above; `"manual"` restores today's human gate.

### 2. Query — enriched `meta`

Request unchanged. Response `meta` gains the lifecycle position:

```json
"meta": {
  "handlerKey": "d38184…",
  "tier": "liquid",
  "cache": "hit",
  "runs": 7,
  "thresholds": { "liquid": 3, "crystal": 10 },
  "readyToCrystallize": false
}
```

The agent that wants a crystal simply keeps calling until
`readyToCrystallize: true`, then calls route 4. No UI, no guesswork.

Error contract fixes (apply to this route):

- Known handler, missing input value → **400 `INVALID_INPUT`** with
  `"expected": { "limit": "number" }, "missing": ["limit"]`. (Today: 500
  `INVALID_HANDLER` with an internals-flavored message. The crystal route's
  wording is the model.)
- Intent wording that resolves to nothing (offline provider) → **422
  `INTENT_UNSATISFIABLE`** plus `"nearest": ["top N accounts by total paid
  invoice amount in cents, highest first"]` — the agent repairs its wording
  and reuses the existing handler instead of creating a gas duplicate.

### 3. Lifecycle — the agent's dashboard

```
GET /v0/lifecycle             x-api-key: slm_…

200 {
  "endpointId": "ep_…",
  "status": "ready",                      # pending | ready | updating | error
  "policy": { "crystallize": "auto" },
  "handlers": [
    { "handlerKey": "d38184…",
      "intent": "top N accounts by total paid invoice amount in cents, highest first",
      "tier": "crystal",                  # gas | liquid | crystal
      "runs": 12,
      "readyToCrystallize": false,        # already crystal
      "route": "/v0/e/d38184…" }          # present once crystal
  ]
}
```

One GET replaces badge-watching, row-reading and the 2-second page refresh.
`status: "updating"` is how the agent observes a crystallization restart.

### 4. Crystallize — the approval, delegated

```
POST /v0/handlers/d38184…/crystallize     x-api-key: slm_…
{}

201 {
  "handlerKey": "d38184…",
  "route": "/v0/e/d38184…",
  "token": "slc_…",                        # shown once
  "exampleBody": { "input": { "limit": 5 } }
}

409 NOT_READY        { "runs": 7, "required": 10 }   # criteria not met
409 REVIEW_REQUIRED                                   # policy.crystallize = "manual"
200 (idempotent)     same body minus "token"          # already crystal
```

Autonomy does **not** weaken the gate — it mechanizes it. The server still
requires, regardless of policy: tier is liquid, `runs ≥ 10`, and the replay
check passes (generated code reproduces recorded answers on recorded inputs).
`policy.crystallize` only decides *who* may pull the trigger: the agent
(`auto`) or a human in the UI (`manual`). What the button did in the UI and
what this route does are the same code path; the UI button stays and simply
becomes optional.

The restart behaves exactly as shipped today: same port, same URL,
`status` passes through `updating` back to `ready` (observable via route 3).

### 5. Crystal route — unchanged

`POST /v0/e/<handlerKey>` with `{ "input": … }`, `slc_` or `slm_` key.
Already correct today, including the 400-with-expected-inputs on missing
values and the strict 401 scoping of `slc_` everywhere else. v1 adopts its
error style as the standard for route 2.

## Error envelope (uniform)

```json
{ "error": {
    "code": "INVALID_INPUT",
    "message": "This endpoint takes input: limit (number). Missing: limit.",
    "retryable": false,
    "expected": { "limit": "number" },     # when applicable
    "missing":  ["limit"],                 # when applicable
    "nearest":  ["…"]                      # 422 only
} }
```

Codes: `UNAUTHORIZED` 401 · `WRITE_REFUSED` 403 · `NOT_READY`,
`REVIEW_REQUIRED`, `ACCOUNT_EXISTS` 409 · `INVALID_INPUT` 400 ·
`INTENT_UNSATISFIABLE` 422 · `PROVIDER_ERROR` 502 · `INTERNAL` 500.
5xx is reserved for Slime's own failures; a malformed client request is
never a 5xx.

## Token model

| Prefix | Scope | Issued by | Shown |
|--------|-------|-----------|-------|
| `sla_` | account control plane (`/v1/*`) | route 0 / UI | once |
| `slm_` | one endpoint: query, lifecycle, crystallize, crystal routes | route 1 | once |
| `slc_` | exactly one crystal route | route 4 | once |

Strictly descending privilege; every journey step needs only the narrowest
token that can perform it. Rotation/revocation stays in the UI for v1.

## Acceptance test

The whole journey from the 2026-11-21 e2e run — sign-up through using the
crystal as its own endpoint, 12 steps — must pass as **one bash script of
curl calls with zero browser launches**. That script is the contract test
for this spec; today the same journey needs two Playwright scripts.

## Out of scope for v1

Endpoint update/delete, token rotation, reviewer workflows, usage/billing
reads, webhooks on tier change (the lifecycle GET covers polling; push can
come later), multi-endpoint listing. The UI keeps all of these.
