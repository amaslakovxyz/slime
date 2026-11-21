# SLIME — Marketing Positioning, Tone of Voice & Commercial Playbook

## 1. Category Strategy & Market Positioning

### Category Definition
* **Category Name:** The Self-Building Backend (*The Living Backend*)
* **The Enemy (Status Quo):** Static API sprawl, hard-coded REST/GraphQL routes, endless DTO boilerplate, Backend-for-Frontend (BFF) ticket queues, and fragile glue code that breaks every time an AI agent or vibecoded UI evolves.
* **The Core Thesis:** Modern frontends are generated in minutes by AI, and autonomous agents reason on the fly—yet backends are still hand-built, one route at a time, out of "petrified clay." Slime flips it: **the backend builds itself.** Your UI or agent asks for data in plain words and the shape it wants; an agent inside Slime writes the API for that request, checks it, reviews it, and keeps it. Every request teaches it. What gets used hardens. Nobody writes the route.

---

### Positioning Statement
> "For AI-native product builders, engineering teams, and platform architects who are bottlenecked by rigid APIs and integration glue, **Slime** is the self-building backend: it grows its own API from what your frontends and agents actually ask for—an agent writes each endpoint on demand, reviews it, and hardens what gets used—while your database, not the AI, decides what it can touch."

---

### How Slime Builds Itself: The Three Matter States (Our Unfair Advantage)
Slime doesn't ship a fixed API. It grows one. Every request moves through three states of matter as Slime develops it from a first guess into permanent, owned code:

| State | Stage of growth | What happens | What the user feels |
| :---: | :---: | :--- | :--- |
| **GAS** <br> *(Tier 0)* | **Born** | A request nobody has asked before. An agent writes the handler on the spot—a read-only query plus the exact JSON shape asked for—runs it safely, and checks the result. It lives on probation; if nobody asks again, it evaporates. | An answer in about a second, for a question no one prepared for. |
| **LIQUID** <br> *(Tier 1)* | **Learned** | Requests that keep succeeding are reviewed by a second model for *meaning*, not just shape (wrong grouping, inverted rankings). Approved handlers are kept, saved, and survive restarts. Rejected ones are rewritten with the reviewer's notes. | The same answer from memory in milliseconds—no AI in the loop. |
| **CRYSTAL** <br> *(Tier 2)* | **Matured** | The most-used paths are rewritten by an optimizing agent, proven against real recorded results, and committed to your repo as ordinary code—revertible, reviewable, yours. | An API you never wrote, now living in your codebase. |

**The point:** Gas → Liquid → Crystal is not a cache. It is a backend developing itself—from synthesis, to learning, to maturity—shaped entirely by real usage.

---

## 2. Tone of Voice & Brand Personality

### Brand Archetype
**Rebellious Systems Engineer meets Bio-Tech Alchemist.**
We speak with the sharp technical authority of a systems architect combined with the energetic, irreverent momentum of the vibecoding era.

```
       [ Systems Rigor ]  <===================>  [ Vibecoding Velocity ]
(Read-only roles, reviewed code)                 (Zero Routes, Instant Shipping)
```

---

### Four Pillars of Voice

1. **Visceral & Elemental**
   * *Rule:* Use physical, organic, and matter-state metaphors (*swallow, digest, grow, harden, crystallize, petrified clay*). Slime is alive: it learns, grows, and matures.
   * *Avoid:* Dry enterprise jargon like "synergistic middleware orchestration."
2. **Technically Unassailable**
   * *Rule:* Ground bold marketing claims in verifiable architecture: database-enforced read-only permissions, second-model review of every handler, sandboxed shaping code, cached handlers you can inspect (SQL shown, assumptions stated), and measured timings (about a second new, milliseconds repeat).
3. **Anti-Boilerplate & Builder-First**
   * *Rule:* Celebrate shipping speed. Highlight the absurdity of writing 14 files across three repos just to add one field to a JSON payload.
4. **Confident, Never Corporate**
   * *Rule:* Short, punchy sentences. Active verbs. Direct statements. Zero corporate filler.

---

### Vocabulary Matrix (Enterprise Jargon vs. Slime Lexicon)

| Corporate / Traditional Jargon | The Slime Lexicon |
| :--- | :--- |
| API Gateway / Middleware | **Living Backend / Void Receiver** |
| Code Generation | **The agent writes your API** / **Gas Synthesis** |
| Caching / Promotion | **Gas $\rightarrow$ Liquid $\rightarrow$ Crystal growth** (born, learned, matured) |
| Code Review / QA | **Digestion check** (a second model reviews every handler) |
| Legacy System Integration | **Swallowing legacy APIs & databases** |
| Role-Based Access Control (RBAC) | **Membrane permissions** (enforced by your database, never by the AI) |
| Ephemeral Sandbox | **Evaporating Gas** (unused handlers simply disappear) |
| Approved Allowlist / Production Lock | **Locked mode** (serve only handlers Slime has already grown) |

---

## 3. Core Use Cases & Copy Blueprints

Roadmap at a glance:

* **Now:** Vibecoded UIs, AI agents, legacy APIs & databases—all **read** access.
* **Next:** Multi-tenant SaaS customizations.
* **Later:** Writes and complex, multi-step operations—each behind stricter checks than reads.

---

### Use Case 1 (Now): The Self-Building Backend for "Vibecoded" UIs & AI-Generated Apps

#### Context & Problem
Tools like Lovable, v0, Bolt, and Cursor build frontends in minutes. Then they hit a wall: real data. Writing REST routes, defining DTOs, and shipping deployments for every widget destroys creative momentum.

#### Slime Solution
Point the AI-generated frontend at Slime and let the backend build itself. When a dashboard widget asks for *"top accounts by revenue"* with the JSON shape it wants, an agent writes the handler in **Gas** (about a second), a second model reviews it, and every later request—with any input values—comes back from **Liquid** in milliseconds. The UI evolves; the backend grows to match.

#### Copy Variations
* **Hero Landing Page:** *"Vibecode your UI in minutes—and let the backend build itself. Your app asks for data in plain words and the shape it wants; Slime writes the endpoint, reviews it, and serves every repeat in milliseconds."*
* **Feature Card:** *"The missing backend for vibecoded apps. Point your UI at Slime and ship real data features without writing a single route or DTO."*
* **Social / Ad Punchline:** *"Vibecode the UI. Let Slime build the backend."*

---

### Use Case 2 (Now): A Self-Building, Database-Guarded API for AI Agents

#### Context & Problem
Giving autonomous agents raw SQL or API keys is a security risk (prompt injection, unauthorized deletions, data leaks). Hand-coding a narrow endpoint for every agent action kills their autonomy.

#### Slime Solution
Agents ask for what they need; Slime builds the API for them, request by request. Every handler runs as a read-only database role that can't write and can't see hidden columns—so even a prompt-injected request is refused by the database itself. The model never sees your rows or input values. Handlers are reviewed before they're trusted, and **locked mode** serves only the ones Slime has already grown.

#### Copy Variations
* **Hero Landing Page:** *"Give AI agents the data they need without giving them the keys. Slime builds the API your agents ask for—reviewed, read-only, and guarded by your database's own permissions."*
* **Feature Card:** *"Safe data access for autonomous agents. The API builds itself; your database stays the boss."*
* **Social / Ad Punchline:** *"Unleash your agents. Keep your database untouchable."*

---

### Use Case 3 (Now): Legacy API & Database "Strangler" (Enterprise Modernization)

#### Context & Problem
Enterprises are bound to legacy SOAP services, aging microservices, and complex database schemas. Every new mobile client or AI tool needs another expensive Backend-for-Frontend layer to stitch fragmented payloads together.

#### Slime Solution
Put Slime in front of existing databases and legacy services. It swallows their schemas and builds a modern API on top of them, one real request at a time—reshaping old payloads into exactly what new clients ask for. Paths that get used harden into Liquid, then mature into Crystal code in your repo, so modernization happens incrementally, without a big-bang rewrite.

#### Copy Variations
* **Hero Landing Page:** *"Stop hand-building BFF middleware to glue old systems together. Slime sits in front of your legacy APIs and databases and builds the modern API your apps ask for—one request at a time."*
* **Feature Card:** *"Swallow legacy APIs whole. Slime digests old schemas and grows a modern API on top of them."*
* **Social / Ad Punchline:** *"Don't rewrite legacy. Let Slime digest it."*

---

### Use Case 4 (Next): Multi-Tenant SaaS Customizations

#### Context & Problem
Enterprise customers keep asking for bespoke reports, custom field mappings, and tailored payloads. Customer-specific code branches create technical debt; per-tenant infrastructure eats margins.

#### Slime Solution
Each customer's custom view becomes its own self-built handler—grown from their requests, reviewed, and kept—on one shared runtime. No forks, no per-customer services. *(Next on the roadmap: tenant separation is not in v0.)*

#### Copy Variations
* **Hero Landing Page:** *"Deliver bespoke data views and custom reports for every enterprise customer without forking your codebase. Slime grows each customer's API from their own requests, on one shared runtime."*
* **Feature Card:** *"Infinite tenant customization, zero code forks."*
* **Social / Ad Punchline:** *"One runtime. Every customer's backend."*

---

### Later: Writes & Complex Operations
Reads come first because the database can guarantee them. Writes and multi-step operations come later, each behind stricter checks than reads: the same self-building loop, with more gates before anything changes.

---

## 4. Master Messaging Bank & Competitive Battlecards

### Hero Headlines
1. *"The backend that builds itself."*
2. *"No tickets. No PRs. No deploys. The backend grows itself."* (use against AI coding agents: they write endpoints faster, but each one is still a ticket, a review and a deploy)
3. *"Stop writing endpoints. Slime writes them."*
4. *"Your UI asks. Slime builds the API."*
5. *"From Gas to Liquid to Crystal: a backend that grows from what you ask for."*
6. *"Stop writing endpoints. Feed the Slime."*

---

### Elevator Pitches

#### 15-Second Pitch
> "Slime is the backend that builds itself. Instead of writing routes and DTOs, you point your vibecoded UI or AI agent at Slime and ask for data in plain words. An agent writes the endpoint in about a second, a second model reviews it, and every repeat is served from memory in milliseconds."

#### 30-Second Pitch
> "Frontends and AI agents now take minutes to build, but backends are still hand-built, one route at a time. Slime builds itself instead. Your app asks for data and the shape it wants; an agent writes a read-only handler on the spot, checks it, and a second model reviews what it means. Handlers that keep being used harden and are kept; the hottest ones mature into ordinary code in your repo. Your database's permissions—not the AI—decide what Slime can touch. You ship the UI; the backend grows to match."

---

### Proof Points (use these, not adjectives)
* **First-try correct:** all 8 benchmark cases passed across three full runs of the prototype engine; generated handlers matched hand-written reference queries on the first try, including nested output shapes. The one query whose meaning was disputed (churn risk) was held back by the review instead of being trusted—the intended safe outcome. *(Measured on the prototype. The same benchmark now lives in `core/bench/`; re-run it with a model on the current engine before quoting new numbers.)*
* **About a second, then milliseconds:** new requests take about 1 s; repeats take a few milliseconds and reuse the handler even when input values change.
* **The review catches real bugs:** it caught grouping by name instead of id, and a churn ranking that pointed the wrong way.
* **The database says no:** a request for password hashes and a request to delete data were both refused; Postgres itself rejects direct writes and hidden-column reads.
* **Nothing hidden:** every answer shows its SQL and the model's assumptions; any handler can be inspected or evicted.

---

### Competitive Battlecards

```
+-------------------+---------------------------+-----------------------------------+
| Competitor Class  | Their Approach            | Why Slime Wins                    |
+-------------------+---------------------------+-----------------------------------+
| GraphQL / Hasura  | Schema stitching & a      | No schema to stitch, no resolvers |
|                   | fixed, pre-declared API   | to write: the API builds itself   |
|                   |                           | from real requests, in the exact  |
|                   |                           | shape each client asks for.       |
+-------------------+---------------------------+-----------------------------------+
| Traditional API   | Route routing, rate       | Gateways only route the endpoints |
| Gateways (Kong)   | limiting, static proxies  | you already wrote; Slime writes   |
|                   |                           | the endpoints, reviews them, and  |
|                   |                           | keeps what gets used.             |
+-------------------+---------------------------+-----------------------------------+
| Agent MCP / Tools | Direct tool execution &   | Raw tools hand agents the keys;   |
|                   | unsecured database access | Slime builds the agent's API on a |
|                   |                           | read-only role, reviews every     |
|                   |                           | handler, and can lock to approved |
|                   |                           | ones.                             |
+-------------------+---------------------------+-----------------------------------+
| AI coding agents  | Write endpoint code       | No loop at all: endpoints grow at |
| (Cursor, Claude   | faster, but every new one | runtime from real requests, get   |
| Code, Copilot)    | is still a ticket, a      | reviewed automatically, and only  |
|                   | review, a PR and a deploy,| what's used is kept. The agent    |
|                   | built from a guess        | builds your API while it runs.    |
+-------------------+---------------------------+-----------------------------------+
| Text-to-SQL /     | Regenerate a query for    | Slime builds once and remembers:  |
| AI BI tools       | every question, return    | handlers are reviewed, reused for |
|                   | raw tables                | new input values, served in       |
|                   |                           | milliseconds, and shaped exactly  |
|                   |                           | as the app needs.                 |
+-------------------+---------------------------+-----------------------------------+
```

---

### Claims We Don't Make
* No latency promises below what we measure ("sub-millisecond", "<1 ms", "150 ms Gas").
* No "native binaries", "AOT compilation", or "formal verification"—Crystal is ordinary code in your repo.
* No "multi-tenant" or "row-level security" until tenancy ships; no "safe writes" until writes ship.
* No absolutes: not "any intent", "always correct", or "prompt-injection proof".
* Demo what's built: today's connector is Postgres. Legacy APIs and files plug into the same connector contract, so pitch them as part of the story but demo on a database.
