# Slime OSS / Slime Cloud split — architecture design

* **Status:** Proposed — awaiting Anton's review
* **Date:** 2026-11-20
* **Base:** `origin/main` @ `402feb5` (code: `sandbox/` only)
* **Plan for the first step:** [plans/2026-11-20-slime-cloud-mvp.md](./plans/2026-11-20-slime-cloud-mvp.md)

## 1. Goal

We are building two products on the `sandbox/` prototype:

1. **Slime OSS (`@slime-cloud/core`, `@slime-cloud/server`)**: Apache-2.0 packages that anyone can self-host.
2. **Slime Cloud**: our SaaS. It runs the same self-hostable Slime Server once
   per customer, and adds a small proprietary platform on top.

This document fixes the seam between them and the MVP scope. Everything else is
listed under [§6 Later](#6-later) and gets designed when it is needed.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | OSS license: **Apache-2.0**. |
| D2 | **One private monorepo** (`amaslakovxyz/slime` is private). `oss/` is exported to a public mirror later. |
| D3 | Slime Cloud data plane is **silo**: one Slime Server process per customer. |
| D4 | LLM keys: **managed by default, BYOK optional**. |
| D5 | Core = **`main`/`sandbox/`**. The write path (unmerged `origin/chore/gas-v0-plan`) comes later as an `EffectSink` Port. |
| D6 | Slime Cloud's target handler store is a **KV store** (DynamoDB or equivalent). The MVP reuses the existing Postgres store (§5). |
| D7 | Customer DB connectivity: **TLS + IP allowlist from a static egress IP**. |
| D8 | **The whole engine is OSS.** We charge for operations and enterprise features. |
| D9 | Contributions are accepted under a **CLA that grants a license** (no assignment). |
| D10 | One npm scope, **`@slime-cloud/*`**, for every package. It supersedes the earlier `@slime-kit/*` and the `@slime/*` names in `concepts_brief.md:25` (`@slime` belongs to a third party, `@slime/stopwatch`). OSS packages (`core`, `server`, adapters) are published; platform packages are private and never published. No `@slime-cloud/*` package is published yet, and whether the `slime-cloud` org is free will only be known when we register it. |

## 3. Layers and repository layout

Layers. A lower layer never imports an upper one.

| Layer | Package | Owns |
|---|---|---|
| Core | `@slime-cloud/core` | Engine, cache key, tiers, review, QuickJS sandbox, the existing Ports (`Connector`, `Generator`, `Reviewer`, `HandlerStore`) and their current implementations |
| Server | `@slime-cloud/server` | HTTP (`POST /v0/query`, admin routes), API-key auth, `.env`/CLI startup |
| Platform | `@slime-cloud/control-plane` and other platform packages (private, never published) | Onboarding, admin, starting and supervising one Server per customer |

```
slime/                              # private monorepo
├── package.json                    # npm workspaces: oss/packages/*, platform/*
├── oss/                            # becomes the public repo root on export
│   ├── docker-compose.yml, db/     # dev Postgres (moved from sandbox/)
│   └── packages/
│       ├── core/                   # @slime-cloud/core   (was sandbox/src without index.ts)
│       └── server/                 # @slime-cloud/server (was sandbox/src/index.ts)
├── platform/
│   └── control-plane/              # @slime-cloud/control-plane: 2 pages + tenant supervisor
└── docs/                           # private: business docs, this document
```

The approved target layout keeps `platform/data-plane/` and `platform/infra/`.
Each directory is created when its first file exists. The MVP needs neither,
because the control plane starts the OSS Server CLI directly.

Boundary rule: `oss/` never imports `platform/` or a platform package (`@slime-cloud/control-plane`, ...). A CI grep
enforces this. The subtree-split export check is added at go-public (§6).

## 4. What silo buys us

Each customer runs in its own process, which covers everything below without
changing Core:

* **No tenant in Core.** The cache key and `StoreScope` stay as they are
  (`sandbox/src/fingerprint.ts:54-62`, `sandbox/src/store.ts:43-47`).
* **Configuration and keys by environment.** The existing module config
  (`sandbox/src/config.ts:35`) and the SDKs' env key lookup work per process.
  Managed vs BYOK is just a different env value.
* **Isolation by process.** QuickJS-in-worker shares a process with one
  customer only. Spectre-class reads cannot cross customers
  (<https://v8.dev/blog/spectre>).
* **Per-customer limits.** The rate limits (`config.ts:77-78`) become
  per-customer limits as they are.

The one Core change the MVP needs: a configurable handler-store table, so that
each customer gets its own table (§5).

## 5. Slime Cloud MVP

Two pages and nothing else. Everything runs locally against the
docker-compose Postgres.

| Piece | Behavior |
|---|---|
| **Onboarding page** `GET/POST /onboarding` | Form fields: name, read-only Postgres URL, provider (`claude` / `groq` / `offline`), optional own API key (BYOK). On submit: `PostgresConnector.safetyCheck()` must pass (`sandbox/src/connectors/postgres.ts:108-128`). Then the tenant is saved, its Server is started, and the endpoint, API key and a `curl` example are shown. |
| **Admin page** `GET /admin` | Protected by HTTP Basic auth with the platform admin token. One table, one row per tenant: name, port, provider, key mode (managed/BYOK), status, and handlers by tier and generations in the last hour (from the tenant's `/healthz`). |
| **Supervisor** | One `@slime-cloud/server` CLI child process per tenant, with an explicit env: its own `PORT`, `SLIME_API_KEY`, `SLIME_ADMIN_KEY`, `SLIME_META_TABLE=handlers_<tenantId>`, and the provider key (BYOK or the platform's managed key). Tenants are restarted when the control plane starts. |
| **Tenant registry** | A git-ignored JSON file. |

Server additions the MVP needs from OSS: an optional `SLIME_API_KEY` for
`/v0/query` and `SLIME_ADMIN_KEY` for the admin routes. Today those routes are
unauthenticated (`sandbox/src/index.ts:23-24`, `:44`, `:48`, `:49`). When the
keys are unset, behavior is unchanged.

## 6. Later

Each item becomes its own spec when we start it.

* **Split Core further**:
  * `@slime-cloud/postgres` and `@slime-cloud/llm` adapter packages;
  * config injection instead of the module singleton;
  * a `SandboxRunner` Port;
  * a `Telemetry` Port, which metering needs (token counts already exist in
    `GenerationStats`, `sandbox/src/engine.ts:52-59`).
* **DynamoDB store** (D6), behind the existing `HandlerStore` Port (`store.ts:49-56`). Core does not change.
  * **Keys:** partition key `tenantId` (passed to the adapter's constructor);
    sort key `schemaHash#promptHash#model#artifactKey`. `loadLiquid` becomes a
    single `Query` with `begins_with`.
  * **Isolation:** the IAM condition
    `ForAllValues:StringEquals dynamodb:LeadingKeys = [tenantId]` restricts
    each customer's task role to its own partition
    (<https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html>).
  * **Integrity:** keep the `codeHash` check on load.
  * **Item size:** cap `history[]` and `fixtures[]`, or store them as separate
    items. A DynamoDB item is limited to 400 KB
    (<https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html>).
* **AWS deploy:**
  * one ECS Fargate service per customer (`concepts_brief.md:237`);
  * a NAT gateway with an Elastic IP for D7;
  * secrets in Secrets Manager;
  * code in `platform/infra/` and `platform/data-plane/`.
* **Metering, billing, accounts, SSO, audit log.**
* **Go public:**
  * LICENSE and NOTICE;
  * CLA bot;
  * trademark policy;
  * claim the npm org;
  * build step for publishing;
  * mirror export with a CI check that `git subtree split --prefix=oss` builds
    on its own.

## 7. Licensing, IP and who pays

* **Patent use (Apache §3).** Every contributor, including us, grants every
  user a royalty-free patent license. It covers patent claims that their
  contributed code necessarily infringes. Anyone who sues claiming the project
  infringes a patent loses that license. If we patent part of Slime, we cannot
  assert it against users of the OSS code. §3 does not protect our IP
  (<https://www.apache.org/licenses/LICENSE-2.0#patent>).
  `[INFERENCE — not legal advice]`
* **What protects our IP:**
  * proprietary `platform/` code, which is never exported;
  * the trademark: §6 grants no trademark rights, so forks may use the code
    but not the name
    (<https://www.apache.org/licenses/LICENSE-2.0#trademarks>). A clearance
    search is needed because "SLIME" is also an Emacs project
    (<https://github.com/slime/slime>);
  * the CLA. Apache-2.0 already lets anyone, us included, use contributions
    commercially. The CLA adds the right to relicense them later, plus a
    provenance record (<https://www.apache.org/licenses/icla.pdf>).
    `[INFERENCE — confirm with counsel]`
* **Who pays.** We follow GitLab's buyer-based open core: a feature's tier
  follows "who cares most about the feature"
  (<https://handbook.gitlab.com/handbook/product/product-processes/tiering-guidance-for-features/>).
  Enterprises pay for:
  * a managed service with no operations on their side;
  * SSO and an audit log;
  * compliance and a DPA;
  * private connectivity;
  * an SLA and support;
  * metered managed-model usage.

## 8. Risks

| # | Risk | Response |
|---|---|---|
| R1 | Moving `sandbox/` conflicts with in-flight branches (`origin/feat/crystal`; worktree `feat/database-adapters`). | Agree timing with the team before plan Task 1. |
| R2 | Fixtures store real customer inputs and query results (`store.ts:9-13`), so Slime Cloud holds customer data at rest. | MVP is local only. Before the first external customer: per-tenant encryption, a TTL, and an opt-out that drops fixtures (Crystal equivalence replay is then unavailable). |
| R3 | The MVP control plane stores customer DB URLs and BYOK keys in a local JSON file. | Local only. Moves to Secrets Manager with the AWS deploy. |
| R4 | Managed keys share one Anthropic organization's rate limits across customers. | Per-customer generation caps (`config.ts:77-78`). Anthropic supports per-workspace limits (<https://platform.claude.com/docs/en/api/rate-limits>). |
| R5 | The `slime-cloud` org name and the "Slime" trademark are not secured. | Register the npm and GitHub orgs; run a trademark search. |

Research trail: two research reports failed the quality gate (wrong line
references, licenses and prices). The previous, longer version of this
document used only facts the validator confirmed. Its details (rejected
alternatives, prices, errata) are in git history (`c976bbc`).
