# Docs index

Project-wide docs. Code-local docs live next to their code and are listed at the bottom. Status: Current (true for main today), Design (proposed, not on main), Vision (pitch, not a contract), Plan (agreed next work), Record (dated snapshot), Superseded (replaced by the doc it names; kept as history).

| Doc | Status | Owner | What it is |
|---|---|---|---|
| [product/concepts_brief.md](product/concepts_brief.md) | Current | Konstantin | Slime v0 tech stack, scope and benchmark results. |
| [product/2026-11-21-agent-integrations-research.md](product/2026-11-21-agent-integrations-research.md) | Record | @Tony | Slime for coding agents: research record behind the unified frame (federation, Linear/Notion limits, N+1, "no customer data"). |
| [product/product_frame_v0_2.md](product/product_frame_v0_2.md) | Design | @Tony | Unified product frame (slime-client / slime-cloud): merged decisions from both 2026-11-21 research tracks, demo vertical, risks. |
| [product/agent_api_v1.md](product/agent_api_v1.md), [product/agent_api_v1.openapi.yaml](product/agent_api_v1.openapi.yaml) | Design | amaslakov | Agent API v1: headless lifecycle for coding agents (one `slm_` token, delegated crystallize); each route and field marked shipped or proposed against main's runtime. |
| [product/crystal_static_host.md](product/crystal_static_host.md) | Design | @Tony | Calling a Crystal endpoint from a static page: `slc_` token per Crystal, `POST /v0/e/<crystal key>`, planned `slime crystallize --emit-html`; CORS and publishable keys later. |
| [product/customer-demo-use-cases.md](product/customer-demo-use-cases.md) | Current | @Tony | Customer demo: three use cases from the customer's coding agent (Cloud endpoint, Crystal, self-hosted multi-source), fast-value table, demo script, measured run. |
| [product/atlas-demo.md](product/atlas-demo.md) | Current | @Tony | DEMO: Atlas, the made-up customer with no backend; what the site shows, what Atlas needed, why it is real. One page for hackathon visitors. |
| [product/atlas-demo-cheatsheet.md](product/atlas-demo-cheatsheet.md) | Current | @Tony | DEMO cheatsheet: who does what (visitor, Atlas's agent and server, operator, runtime), diagrams of the request and the Gas → Liquid → Crystal lifecycle, 7-step onboarding, keys, errors, talking points. |
| [product/2026-11-22-atlas-public-site-plan.md](product/2026-11-22-atlas-public-site-plan.md) | Record | @Tony | How the Atlas customer site was put on a public Lambda Function URL (stack `platform/infra/atlas`, SSM keys, panel 3 off), what was verified, and the optional custom-domain step. |
| [product/slime_runtime_master_spec.md](product/slime_runtime_master_spec.md) | Vision | — | Pitch and target architecture (V8/Wasm, Redis, connectors). Conflicts in places with the dev spec. |
| [architecture/architecture-spec.md](architecture/architecture-spec.md), [architecture/architecture.excalidraw](architecture/architecture.excalidraw) | Superseded | @Tony | Bun/intents/Gatekeeper dev spec and its diagram. Its implementation branches (`feat/shop-bench`, `chore/gas-v0-plan`) were never merged; superseded by [../core/PLAN.md](../core/PLAN.md), the engine on main. |
| [architecture/slime-cloud.html](architecture/slime-cloud.html) | Superseded | @Tony | Slime Cloud admin + per-endpoint Lambda provisioner (removed): topology, lifecycle, data model, IAM, pricing. Superseded by the cloud MVP design below. Open in a browser. |
| [architecture/2026-11-21-endpoint-lifecycle-tab-design.md](architecture/2026-11-21-endpoint-lifecycle-tab-design.md), [architecture/mockups/2026-11-21-endpoint-lifecycle.html](architecture/mockups/2026-11-21-endpoint-lifecycle.html) | Record | @Tony | Admin Lifecycle tab and local runner, built on main (dated design; details may lag the code). Endpoint on a local DB, agent snippet, Gas → Liquid → Crystal with a Crystallize button; L20–L23 record how the cloud MVP runs the same flow on Lambda. The mockup is static. |
| [architecture/2026-11-22-request-trace-drawer-design.md](architecture/2026-11-22-request-trace-drawer-design.md), [architecture/2026-11-22-request-trace-drawer-plan.md](architecture/2026-11-22-request-trace-drawer-plan.md), [architecture/mockups/2026-11-22-request-trace-drawer.html](architecture/mockups/2026-11-22-request-trace-drawer.html) | Record | @Tony | Requests log trace drawer, built on main (dated design; details may lag the code): the engine records which harness layers each request passed or where it was refused (`QueryMeta.trace`, `SlimeError.trace`), the feed keeps traces and refusals, the admin shows Layers / Route map / Waterfall. Merged in PR #65; the plan is the task-by-task record; the mockup is static. |
| [architecture/2026-11-21-cloud-mvp-design.md](architecture/2026-11-21-cloud-mvp-design.md), [architecture/2026-11-21-cloud-mvp-brief.md](architecture/2026-11-21-cloud-mvp-brief.md) | Record | amaslakov | Slime Cloud MVP on AWS, built on main (dated design; details may lag the code): one multi-tenant `slime-runtime` Lambda for all endpoints (`/ep/<id>/…`), hosted admin at admin.amaslakov.com (Lambda + Web Adapter + CloudFront, invite-only), Crystals in S3 run in QuickJS, provisioner removed. The brief records the Goldfish review. |
| [brand/slime_master_brand_book_agent_design_system.md](brand/slime_master_brand_book_agent_design_system.md) | Current | — | Color tokens, typography, and UI rules for agents generating Slime UI. |
| [brand/slime_master_brand_book_design_system.html](brand/slime_master_brand_book_design_system.html) | Current | — | Interactive brand book and component kit. |
| [brand/slime_marketing_positioning_tone_of_voice_use_cases.md](brand/slime_marketing_positioning_tone_of_voice_use_cases.md) | Current | — | Positioning, tone of voice, use cases, and messaging. |

## Code-local docs

- [../core/README.md](../core/README.md) (Current, engine package; its `src/*/README.md` files map each module)
- [../core/PLAN.md](../core/PLAN.md) (Plan, engine milestones)
- [../core/docs/request-format.md](../core/docs/request-format.md) (Current, request format)
- [../core/docs/extending.md](../core/docs/extending.md) (Current, extension points and their contract tests)
- [../core/docs/multi-source.md](../core/docs/multi-source.md) (Current, multi-source handlers: Postgres + Notion + REST APIs; built, live Notion run pending)
- [../core/docs/multi-source-implementation.md](../core/docs/multi-source-implementation.md) (Plan, step-by-step implementation of multi-source handlers; merged in PR #26, P0–P6 done, P6.5 live run pending)
- [../crystal/README.md](../crystal/README.md) (Current, crystallize job, typed services, `slime-crystal` CLI)
- [../examples/multi-source/README.md](../examples/multi-source/README.md) (Current, multi-source example)
- [../examples/hono/README.md](../examples/hono/README.md) (Current, smallest app around the core)
- [../examples/customer-site/README.md](../examples/customer-site/README.md) (Current, customer demo site)
- [../examples/express/README.md](../examples/express/README.md) (Current, example app and demo database)
- [../examples/shop/README.md](../examples/shop/README.md) (Current, demo shop database and 10 use cases)
- [../platform/runtime/README.md](../platform/runtime/README.md) (Current, shared runtime Lambda and local entry)
- [../platform/admin/README.md](../platform/admin/README.md) (Current, Slime Cloud admin, local and hosted)
- [../platform/landing/README.md](../platform/landing/README.md) (Current, landing page)
- [../platform/infra/README.md](../platform/infra/README.md) and [../platform/infra/FINOPS.md](../platform/infra/FINOPS.md) (Current)
- [../platform/docs/reviews/2026-11-20-infra-review.md](../platform/docs/reviews/2026-11-20-infra-review.md) (Record)
- [../platform/docs/reviews/2026-11-21-local-e2e-test.md](../platform/docs/reviews/2026-11-21-local-e2e-test.md) (Record, local end-to-end run through Gas → Liquid → Crystal and a zero-context tester)
- [../platform/docs/reviews/2026-11-22-api-path-audit.md](../platform/docs/reviews/2026-11-22-api-path-audit.md) (Record, runtime and admin API paths against docs and specs)
