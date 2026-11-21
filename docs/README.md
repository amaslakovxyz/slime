# Docs index

Project-wide docs. Code-local docs live next to their code and are listed at the bottom. Status: Current (true for main today), Design (proposed, not on main), Vision (pitch, not a contract), Plan (agreed next work), Record (dated snapshot).

| Doc | Status | Owner | What it is |
|---|---|---|---|
| [product/concepts_brief.md](product/concepts_brief.md) | Current | Konstantin | Slime v0 tech stack, scope and benchmark results. |
| [product/2026-11-21-agent-integrations-research.md](product/2026-11-21-agent-integrations-research.md) | Record | @Tony | Slime for coding agents: research record behind the unified frame (federation, Linear/Notion limits, N+1, "no customer data"). |
| [product/product_frame_v0_2.md](product/product_frame_v0_2.md) | Design | @Tony | Unified product frame (slime-client / slime-cloud): merged decisions from both 2026-11-21 research tracks, demo vertical, risks. |
| [product/slime_runtime_master_spec.md](product/slime_runtime_master_spec.md) | Vision | — | Pitch and target architecture (V8/Wasm, Redis, connectors). Conflicts in places with the dev spec. |
| [architecture/architecture-spec.md](architecture/architecture-spec.md), [architecture/architecture.excalidraw](architecture/architecture.excalidraw) | Design | @Tony | Bun/intents/Gatekeeper dev spec and its diagram. Implemented only on unmerged `feat/shop-bench`, `chore/gas-v0-plan`. The engine on main is `core/`. |
| [architecture/slime-cloud.html](architecture/slime-cloud.html) | Current | @Tony | Slime Cloud admin + endpoint provisioner: topology, lifecycle (create/reconfigure/delete), data model, IAM, pricing. Open in a browser. |
| [architecture/2026-11-21-endpoint-lifecycle-tab-design.md](architecture/2026-11-21-endpoint-lifecycle-tab-design.md) | Design | @Tony | Admin Lifecycle tab and local runner (local-only for now: the live view and Crystallize are wired under `npm run local`, not on Lambda). Endpoint on a local DB, agent snippet, Gas → Liquid → Crystal with a Crystallize button. |
| [architecture/2026-11-21-cloud-mvp-design.md](architecture/2026-11-21-cloud-mvp-design.md), [architecture/2026-11-21-cloud-mvp-brief.md](architecture/2026-11-21-cloud-mvp-brief.md) | Design | amaslakov | Slime Cloud MVP on AWS: one multi-tenant `slime-runtime` Lambda for all endpoints (`/ep/<id>/…`), hosted admin at admin.amaslakov.com (Lambda + Web Adapter + CloudFront, invite-only), Crystals in S3 run in QuickJS, provisioner removed. The brief records the Goldfish review. |
| [brand/slime_master_brand_book_agent_design_system.md](brand/slime_master_brand_book_agent_design_system.md) | Current | — | Color tokens, typography, and UI rules for agents generating Slime UI. |
| [brand/slime_master_brand_book_design_system.html](brand/slime_master_brand_book_design_system.html) | Current | — | Interactive brand book and component kit. |
| [brand/slime_marketing_positioning_tone_of_voice_use_cases.md](brand/slime_marketing_positioning_tone_of_voice_use_cases.md) | Current | — | Positioning, tone of voice, use cases, and messaging. |

## Code-local docs

- [../core/PLAN.md](../core/PLAN.md) (Plan, engine milestones)
- [../core/docs/request-format.md](../core/docs/request-format.md) (Current, request format)
- [../core/bench/protocol-cases.md](../core/bench/protocol-cases.md) (Design; benchmark material)
- [../examples/express/README.md](../examples/express/README.md) (Current, example app and demo database)
- [../platform/runtime/README.md](../platform/runtime/README.md) (Current)
- [../platform/provisioner/README.md](../platform/provisioner/README.md) (Current)
- [../platform/infra/README.md](../platform/infra/README.md) and [../platform/infra/FINOPS.md](../platform/infra/FINOPS.md) (Current)
- [../platform/docs/reviews/2026-11-20-infra-review.md](../platform/docs/reviews/2026-11-20-infra-review.md) (Record)
