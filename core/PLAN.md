# @slime-cloud/core: library plan

* **Status:** draft. M0 to M3 and M5 are done. M4, M6 and M7 are built: M4 and M6 wait for runs against a real model (M4's was done through the example app), and M7 waits for the runtime owner to run the handler copy and deploy. `sandbox/` is deleted.
* **Date:** 2026-11-20 (review fixes and follow-ups 2026-11-21)
* **Owner:** Konstantin (core only; server and Slime Cloud are owned by others)

## 1. Goal

Turn the sandbox prototype into a library that can be packaged, installed
and used:

* `npm install @slime-cloud/core`;
* configure it in code;
* call `slime.query()` inside any Node app.

Core is the engine from now on; the team agreed on 2026-11-20 that `sandbox/`
is not used any more. Core is a new package, not a move of `sandbox/`. Sandbox
code and tests may be copied where they help, but they are reshaped into a
library: options in, no global state, no `.env` reading. Nothing has to match
the sandbox's behavior.

**How it works.** The first time Slime sees a request, a model writes a
read-only SQL query plus an optional shaping function. Slime checks and runs
them, then caches the result as a handler. Repeat requests reuse the handler,
even with different input values. Handlers move up through three tiers:

* **Gas:** newly generated, held in memory, and expires.
* **Liquid:** ran successfully `gasToLiquidRuns` times and passed a background
  review by a second model (if a reviewer is configured, M4); saved in the
  store.
* **Crystal:** rewritten by an agent into modules in the app's own code (C10).

Core is the bottom layer. `@slime-cloud/server` (a standalone HTTP server) and
Slime Cloud (the hosted, multi-tenant service on AWS) build on it and are
owned by others.

## 2. What we start from

| Source | What it says about core |
|---|---|
| `docs/product/concepts_brief.md` | Library first (`@slime/core`), standalone server later. Read-only, Postgres, `{ intent, input, output }`, Gas → Liquid → Crystal. First next step: "turn the sandbox into the library plus an example app". |
| `sandbox/` on `main` | Working engine, about 88 tests. Gas, Liquid in Postgres, background review, Crystal ([PR #6](https://github.com/amaslakovxyz/slime/pull/6)), offline/Groq/Claude providers. Configured through a global `config` that reads env and `.env`. |
| [PR #7](https://github.com/amaslakovxyz/slime/pull/7) (closed 2026-11-21) | Layers: core → server → platform. Name `@slime-cloud/core` at `oss/packages/core`. Its plan moves `sandbox/` there with `git mv`, and adds `SLIME_META_TABLE`. Lists "config injection instead of the module singleton" as later work. |
| `chore/gas-v0-plan`, `onboarding` | The other direction (Bun, SQLite, named intents, writes). Not the base for core. Useful later for the write path (`EffectSink`). |
| `platform/runtime/` on `main` | **The first consumer of core.** Slime Cloud's runtime on AWS Lambda with handlers in DynamoDB (table `slime-handlers`, partition key `tenantId`, sort key `artifactKey`). It compiles `sandbox/src` through a path mapping and imports deep modules (`@slime-cloud/core/engine.js`, `config.js`, `store.js`). It must set env before importing, because `config` reads env at import time, and it flushes store writes before every response, because Lambda freezes the process afterwards. Its own `DynamoHandlerStore` implements the sandbox's `HandlerStore`. |

PR #7 planned to move the sandbox to this path as is, with `git mv`. It was
closed on 2026-11-21; core is built at `core/` as a new library
instead. Its layering (core → server → platform) and the `@slime-cloud` name
still hold: server and platform build on `createSlime()`.

`platform/runtime` switches to the package (agreed with the team; its README
still says `sandbox/` gets published, which is now out of date). The runtime
changes in a few places (§7, M7):

* it uses `createSlime(new SlimeConfig(…))` instead of setting env before
  importing;
* it replaces its own `DynamoHandlerStore` with a `SlimeStore` over the same
  table;
* it imports the package instead of the path mapping to `sandbox/src`.

## 3. Decisions

Status: **Decided**, **Proposed** (default unless someone objects) or
**Open** (we decide together next).

| # | Question | Proposal | Status |
|---|---|---|---|
| C1 | Name and location | `@slime-cloud/core` in `core/`, inside npm workspaces at the repo root (PR #7 D10). | Decided |
| C2 | Start from scratch or move the sandbox? | New package. Core is the only engine; `sandbox/` is frozen and not used (team agreement, 2026-11-20). Its code and tests are a quarry to copy from, not a reference to match. It is deleted in M6, once `platform/runtime` has switched to the package (M7). | Decided |
| C3 | Runtime | v1: Node ≥ 22, ESM only. Built so that other runtimes (Bun, Deno) can be added later without touching the engine. Runtime-specific code stays behind Ports: the shaping sandbox (QuickJS in a worker thread) goes behind a new `SandboxRunner` Port, and database drivers stay behind `Connector`. The engine uses only `node:*` modules that Bun and Deno also provide. | Decided |
| C4 | Configuration | A `SlimeConfig` class. The app creates it and adds the parts it needs: connector, generator, store, limits. Each part can come from env, a secrets store or anywhere else in the app. The class fills defaults, validates everything at once (reporting every problem, not just the first), and is immutable; `config.with({...})` returns a changed copy for tests. Core never reads `process.env` or `.env`. | Decided (class shape: Proposed) |
| C5 | Entry point | Three steps in the app: create a connector (where data comes from), create a Slime instance with `createSlime(config)`, then call `slime.query()` inside any endpoint. The instance's methods are listed in §5. | Decided |
| C6 | Locked mode | Locked means no `generator` is passed. Then no model client is ever imported, by construction. An explicit `mode` setting can be added later without breaking this. Explore mode is the opposite: a `generator` is passed, and Slime generates handlers for new requests. | Decided |
| C7 | Packaging of adapters | Subpath exports from one package: `@slime-cloud/core/postgres`, `/claude`, `/groq`, `/offline`. Model SDKs and database drivers are optional peer dependencies. | Decided |
| C8 | What ships | Compiled JS and `.d.ts` in `dist/` (built with `tsc`), plus the shaping sandbox's worker file. Not TS source. | Decided |
| C9 | HTTP | No HTTP in core. The app calls `slime.query()` from its own endpoint in any framework. A thrown `SlimeError` carries `status` and `toJSON()`, so the endpoint can return it directly. Admin data comes from methods only (`handlers()`, `stats()`, `evict()`); exposing and protecting them over HTTP is up to the app or `@slime-cloud/server`. | Decided |
| C10 | Crystal | Crystal handlers are ordinary modules in the app's own code. The crystallize job writes JS modules (`.mjs`), plus a generated `index.mjs` with `index.d.mts` and a manifest. The app imports the index and passes it as `crystal` in `SlimeConfig`; leaving it out (or `false`) turns Crystal off. Because the code is compiled with the app, safety is checked when the job writes it (allowlist, SQL lint, equivalence test on recorded runs) and by a `check` command in the app's CI, which re-parses the sources and compares manifest hashes. Core doesn't re-check at startup. The job and `check` are a separate entry (`@slime-cloud/core/crystallize`, plus a bin), so the runtime never imports them. | Decided |
| C11 | Observability | An `onEvent(event)` option (the `SlimeEvent` types in §5). Core doesn't log on its own. Metering builds on this later. | Decided |
| C12 | Out of scope for core v1 | Writes, tenancy (core has no tenant concept; a store isolates tenants if needed), built-in stores other than file and memory, semantic matching. Connectors other than Postgres were out of scope too; MS1 amends that: read-only API sources beside exactly one SQL source (§3.1). | Proposed (amended by MS1) |
| C13 | Store contract | A small key-value Port, `SlimeStore`: `get(ns, key)`, `put(ns, key, value)`, `list(ns, prefix?)`, `delete(ns, key)`. Values are JSON. Namespace: `handlers`. The engine builds the keys (the request key, §4.7), so a backend is only a mapping to 4 calls. It replaces the sandbox's domain-shaped `HandlerStore`. | Decided |
| C14 | Choosing a store | The `store` option takes any object that implements `SlimeStore`. Core ships two that need no extra packages: `fileStore(dir)` (the default, `./.slime`) and `memoryStore()`. Other backends (Postgres, DynamoDB, Redis) are custom stores; Slime Cloud brings its own (M7). | Decided |
| C15 | Background work on serverless | Core runs store writes and background reviews off the request path. On Lambda the process is frozen after each response, so `slime.flush()` must be awaited before every response. It waits for queued writes and running reviews. Work that never ran is redone on a later request. | Proposed |

### 3.1 Multi-source decisions (MS)

One Slime instance reads from one SQL source and any number of read-only API
sources (Notion first), and a handler can combine them. Why, the threat model
and the alternatives are in [docs/multi-source.md](./docs/multi-source.md); the
work is in [docs/multi-source-implementation.md](./docs/multi-source-implementation.md).
None of this is implemented yet. With no API source configured, Slime stays
byte-identical to today (MS3).

| # | Decision | Status |
|---|---|---|
| MS1 | `sources` config: a map of named sources with exactly one SQL source and any number of API sources. `connector: x` means `sources: { db: x }`, and `config.connector` stays a required `Connector`. | Proposed |
| MS2 | API source port: `describe({ timeoutMs, signal })`, `call(operation, args, { timeoutMs, rowCap, signal })`, `safetyCheck({ timeoutMs, signal })`, `close()`, `secrets`. Rows are flat plain JSON in output-notation leaf types, nullable where declared, with no list columns. | Proposed |
| MS3 | v2 artifact `{ version: 2, unsatisfiable, steps, shapeJs, assumptions }`, produced only when an API source is configured. A v2 artifact whose only step is SQL is converted to v1 before its first run by nesting the model's `shape` inside a v1 `shape(rows, input)`. | Proposed |
| MS4 | An API step's `args` is a list of `{ param, input, value }` with exactly one of `input` and `value` set (a list, because model structured output accepts only closed objects). Constants are checked against the parameter's type and `values`. | Proposed |
| MS5 | New limits: `maxSteps` (default 4) and `apiTimeoutMs` (default 10 000). SQL steps keep `statementTimeoutMs`; every step keeps `rowCap`. | Proposed |
| MS6 | A truncated step in a handler with more than one step fails the run with `QUERY_TOO_LARGE` (422). During generation it is repairable. | Proposed |
| MS7 | API failures become `SOURCE_ERROR` (502): retryable for 429, 5xx and timeouts, not retryable for other 4xx. Final during generation. Details carry source, operation, status and attempts, never secrets. | Proposed |
| MS8 | Startup fails if any source fails `describe()` or `safetyCheck()`, in explore and locked mode. | Proposed |
| MS9 | Handlers with an API step are not crystallized. | Proposed |
| MS10 | API adapters reach the network only through the constrained HTTP client: fixed base URL, origin check, no `//` or `..` in paths, same-origin redirects only, 10 MB response cap. | Proposed |
| MS11 | New code lives in `core/src/sources/`. | Proposed |
| MS12 | Notion: schema discovered at startup; generated equality and range parameters; metadata sanitized; property descriptions opt-in; at most 2 requests in flight per source; `people`, `relation`, `files`, `formula` and `rollup` excluded. | Proposed |
| MS13 | Cross-source join hints are column comments (`matches db.accounts.name`); there is no separate links config. | Proposed |
| MS14 | Saved v2 handlers are linted against today's sources on load and at locked startup. A failing handler is not served: explore mode regenerates it, locked mode answers `HANDLER_NOT_FOUND`. | Proposed |
| MS15 | For v2, repair messages sent to the model carry error codes, paths and types, never values. | Proposed |
| MS16 | Every source method is called through one wrapper that applies the timeout and redacts the source's secrets; the HTTP client adds every header value it sends to the secrets. | Proposed |
| MS17 | Provenance records one hash per source (`sourceHashes`, additive). Crystal's schema warning compares only the SQL source's hash. | Proposed |

## 4. Request format and matching

`slime.query(request)` takes `{ intent, input?, output }` and returns
`{ data, meta }`. The caller says what it wants in words, passes the values
separately, and gives the shape it wants back:

```json
{
  "intent": "top N accounts by total paid amount, highest first",
  "input": { "limit": 5, "country": "DE" },
  "output": [{ "name": "string", "totalPaid": "integer" }]
}
```

A vague intent leaves the model to guess, and its guesses show in
`meta.assumptions` (R9). If a result is wrong, the developer rewords the intent: that is a new
key, so Slime generates again, and the old handler stays until it expires
(Gas) or is deleted (Liquid).

A structured protocol (`from`, `where` with operators, `groupBy`, paths) was
designed and dropped on 2026-11-20. It turned the request into a query
language to learn. In the 35 cases analysed in
[bench/protocol-cases.md](bench/protocol-cases.md), 5 needed new operators and
grouping was the weak spot, while the ambiguous cases (#18, #19, #23) were
about what a term means, which structure doesn't fix. The protocol is in this
file's git history, and the cases stay as benchmark material.

### 4.1 Fields

| Field | Required | Rules |
|---|---|---|
| `intent` | **yes** | Non-empty string, at most 500 characters. What is wanted, in words. Values belong in `input`, not in the text (R7). |
| `input` | no (missing means `{}`) | Object, at most 20 keys. Names match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`. Values: string, number, boolean, `null`, or a list of those. `limit` and `offset` are reserved (R6). |
| `output` | **yes** | The response shape (§4.2). Keys are returned exactly as written. |

### 4.2 Output notation

* **Leaves:** `"string"`, `"number"`, `"integer"`, `"boolean"`, `"date"`
  (`YYYY-MM-DD`) or `"datetime"` (ISO 8601 with time zone), each optionally
  followed by `|null`. Every leaf is checked, including the date formats.
* **Lists:** `[X]` means a list of `X`.
* **Objects:** an object means exactly those keys.
* **Top level:**
  * a list means rows;
  * an object means one row: `data` is `null` when there is none, and more
    than one is a `SHAPE_MISMATCH`.
* **Limits:** at most 6 levels deep and 50 fields.

### 4.3 Request decisions

| # | Question | Decision | Status |
|---|---|---|---|
| R1 | What does a request contain? | `{ intent, input?, output }`. `intent` and `output` are required; `input` is optional. | Decided |
| R2 | What is hashed? | All three fields: the normalized `intent` (R3), the input signature (R4) and `output`. Different request = different key = a new generation. | Decided |
| R3 | How is `intent` normalized? | Unicode NFKC, lowercase, repeated whitespace collapsed to one space, trimmed, trailing `.!?;:,` removed. Nothing more: no synonyms, no stemming, no model. A key must be deterministic. | Decided |
| R4 | What of `input` is hashed? | The key **names** only, sorted. Never the values, so `{ limit: 5 }` and `{ limit: 50 }` share a handler. Types are not in the key either: the handler records each parameter's coarse type (`string`, `number`, `boolean`, `list`) from the first non-null value it sees, and a later value of another type fails with `INVALID_REQUEST`. So `5` and `5.5` share a handler, and a parameter behaves like a typed route parameter. | Proposed |
| R5 | Optional filters (`null`)? | Every parameter may be `null`, meaning "not given". The key doesn't change, and the generator is told every parameter is nullable, so it writes `($1 IS NULL OR country = $1)`. A frontend with 5 optional filters always sends all 5 keys and gets **one** handler, not 32. Leaving a key out entirely is a different request. | Proposed |
| R6 | Paging? | `input.limit` and `input.offset` are reserved: non-negative integers. After each run Slime checks, without a model, that the top-level list has at most `limit` rows; a failed check is a failed run. | Decided |
| R7 | Values written into the intent? | An intent that seems to contain a literal (a number, quoted text, an email, a UUID) gets a warning in `meta.warnings` that says to move the value into `input`. A warning, not an error, because "top 10" and possessives match too. | Proposed |
| R8 | Explore vs locked in production? | Generation is for development. In explore mode anyone who can send a request (including from a browser's devtools) can make Slime generate a new read query against everything the connector's read-only database user (`slime_reader` in the examples) can see. So the documented setup is: **explore in development, locked in production** (C6), serving only handlers that were saved (Liquid) or crystallized. Intents then act as named routes. | Decided |
| R9 | Can the developer see what was generated? | Yes, in explore mode. `meta` then carries `sql`, `shapeJs` and the model's `assumptions`; in locked mode they are left out. On every new generation core emits an `onEvent` event (C11) with them, so a dev setup can print it to the console. A wrong answer is only fixable if it's visible. | Decided |
| R10 | Matching by meaning (embeddings, a model normalizing the text)? | No. A non-deterministic key is worse than one extra generation. | Decided |
| R11 | Can `input` carry authorization? | No. The caller can set any `input` value, including `null` (R5). In production the app's endpoint chooses the intent and sets every identity-bound value (account, user, tenant) on the server; it never passes the request body through. | Proposed |

### 4.4 Startup dictionary

Before the first generation, `createSlime()` reads the database's metadata
once and renders a **dictionary**: the text every generation gets as context.

| # | Question | Decision | Status |
|---|---|---|---|
| D1 | What does Slime read from the database? | Metadata only, never row data: tables, columns, types, comments, primary and foreign keys, and the allowed values of enum-like columns. Those come from the catalog (Postgres enums and `CHECK … IN (…)` constraints), not from the rows. | Decided |
| D2 | Who writes the dictionary? | Slime, not a model. It renders the metadata, the app's `glossary` and the app's `rules` as text. The same inputs always give the same text. Model-written SQL notes may be added later behind the same context, if the M6 bench shows they help. | Decided |
| D3 | Where is it stored? | Nowhere. It is rebuilt from the live metadata at each start. | Decided |
| D4 | Blocking or background? | `createSlime()` awaits it. It is one catalog read. | Decided |
| D6 | When is it rebuilt? | At every start. Its hash is recorded in each handler (§4.7). In explore mode a changed hash regenerates a handler the next time it is requested. | Proposed |
| D7 | Locked mode? | Built the same way; no model is needed. Saved handlers are served even if its hash differs from the one they recorded (§4.7). | Proposed |

D5 and D8 (waiting for a background build, `slime.dictionary()`) were dropped
with the model-written dictionary on 2026-11-21; the numbers are not reused.

### 4.5 What the model sees

* the dictionary (§4.4): metadata, glossary and the app's rules;
* the intent;
* the input key names, with their types when known;
* `output`.

It never sees input values or rows.

### 4.6 What comes back

* **`data`** matches `output` exactly: no missing keys, no extra keys, right
  types and date formats. Otherwise the run fails with `SHAPE_MISMATCH`.
* **`meta`**: see `QueryMeta` in §5.
* **Errors** are thrown as `SlimeError`: `{ code, message, retryable }` with an
  HTTP `status` (C9).

### 4.7 Storage: chosen in the config

Core depends on no database for its own storage. Everything it keeps (Liquid
handlers with their fixtures, and run counts) goes through the `SlimeStore`
Port (C13).

A fixture is the `input` of one successful run, used by Crystal's equivalence
test. It holds no rows. Input values do reach the store, and the committed
`.slime/` with it.

```ts
export interface SlimeStore {
  init?(): Promise<void>;  // optional: create or check a table
  get(ns: string, key: string): Promise<unknown | undefined>;
  put(ns: string, key: string, value: unknown): Promise<void>;
  list(ns: string, prefix?: string): Promise<{ key: string; value: unknown }[]>; // keys starting with prefix
  delete(ns: string, key: string): Promise<void>;
  close?(): Promise<void>; // optional: release connections
}
```

The engine keys handlers by the request key alone: `handlers` /
`${requestKey}`. Each stored handler records where it came from: the schema,
dictionary and prompt hashes and the model name. In explore mode, a handler
whose record differs from the current values counts as a miss: Slime
generates again and overwrites it. In locked mode Slime serves the stored
handler as it is, and emits one `onEvent` warning at startup if the schema
hash differs.

The app picks the store in `SlimeConfig`:

```ts
new SlimeConfig({ connector, store: fileStore('./.slime') }); // the default when store is left out
new SlimeConfig({ connector, store: memoryStore() });         // tests
new SlimeConfig({ connector, store: myStore });               // anything implementing SlimeStore
```

#### Why files are the default

They follow the explore → locked flow (R8).
In development, handlers are written to `./.slime/`. The developer commits
that folder, like Crystal. In production, locked mode only reads it: no
database for Slime's own state, and no model. A team that doesn't want state
in git uses a custom shared store; in production they then work in locked
mode too, against a store filled during development.

#### File store rules

* one JSON file per key: `.slime/<ns>/<key>.json`;
* writes go to a temporary file first, then a rename, so a crash never leaves
  half a file;
* **one writer per store:** core v1 assumes a single process writes to a
  store. In locked mode Slime never writes, and run counts stay in memory.
  Several writers need a custom store that handles them.

A shared store for several instances is a custom store: one table keyed by
`(ns, key)` is enough.

#### Contract test

One contract test (`src/testing/store-contract.ts`) runs against every store, the
built-in ones and any custom store.

## 5. Draft public API

The target API. Only C4's class shape and the items in §9 are still open.

```ts
import express from 'express';
import { createSlime, SlimeConfig, SlimeError, fileStore } from '@slime-cloud/core';
import { postgresConnector } from '@slime-cloud/core/postgres';
import { claude } from '@slime-cloud/core/claude';
import { crystals } from './slime-crystal/index.mjs';

// The app decides where values come from: env here, but any source works.
const config = new SlimeConfig({
  connector: postgresConnector({ url: process.env.READER_URL! }), // required; createSlime() refuses database users that can write
  store: fileStore('./.slime'),                                    // the default (§4.7)
  generator: claude.generator({ apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-haiku-5-5' }), // omit = locked mode
  reviewer: claude.reviewer({ apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-opus-5-5' }),    // omit = no review
  crystal: crystals,                                               // omit = off
  glossary: { revenue: 'sum of paid invoices, in cents' },        // optional; meaning of the app's words (§4.4)
  rules: ['Count only paid invoices as revenue.'],                 // optional; added to the dictionary (D2)
  tiers: { gasToLiquidRuns: 3, gasWindowMs: 3_600_000 },           // optional; see DEFAULT_TIERS
  limits: { rowCap: 1_000, statementTimeoutMs: 2_000, maxGenerationsPerHour: 200 }, // optional; see DEFAULT_LIMITS (per instance)
  onEvent: (e) => console.log(JSON.stringify(e)),
}); // throws one SlimeConfigError listing every problem

const slime = await createSlime(config);
const app = express().use(express.json());

// Each endpoint picks its intent and sets identity-bound values itself (R11).
app.get('/api/top-accounts', async (req, res) => {
  try {
    res.json(await slime.query({
      intent: 'top N accounts by total paid amount, highest first',
      input: { limit: Number(req.query.limit ?? 5), orgId: req.user.orgId }, // req.user set by the app's auth
      output: [{ name: 'string', totalPaid: 'integer' }],
    }));
  } catch (err) {
    if (err instanceof SlimeError) return res.status(err.status).json({ error: err.toJSON() });
    throw err;
  }
});

await slime.close(); // on shutdown
```

The instance, its results and its events:

```ts
interface Slime {
  query(request: SlimeRequest): Promise<QueryResult>;
  handlers(): HandlerSummary[];             // Liquid and Crystal; replaces runtime listHandlers()/listCrystals()
  stats(): SlimeStats;                       // counts per tier, generations this hour, queue length
  evict(handlerKey: string): Promise<boolean>; // removes from memory and the store; false if unknown
  flush(): Promise<void>;                    // waits for queued store writes and running reviews
  close(): Promise<void>;
}
interface QueryResult { data: unknown; meta: QueryMeta }
interface QueryMeta {
  handlerKey: string;
  tier: 'gas' | 'liquid' | 'crystal';
  cache: 'hit' | 'miss' | 'coalesced';
  truncated: boolean;                        // rowCap cut the rows
  timingsMs: { total: number; generate?: number; run: number; shape: number };
  warnings: string[];
  review: 'none' | 'pending' | 'approved' | 'rejected';
  sql?: string; shapeJs?: string; assumptions?: string[]; // explore mode only (R9)
}
type SlimeEvent =
  | { type: 'generated'; handlerKey: string; sql: string; shapeJs?: string; assumptions: string[]; tokens: number; ms: number }
  | { type: 'reviewed'; handlerKey: string; verdict: 'approved' | 'rejected'; notes: string }
  | { type: 'promoted'; handlerKey: string; tier: 'liquid' }
  | { type: 'warning'; message: string }
  | { type: 'error'; code: string; message: string };
```

Contracts (Ports) that core exports, each in its port folder's `types.ts` (§6):

* `Connector`: `name`, `describe`, `check`, `run`, `safetyCheck`, `close`.
  `describe` returns the allowed values of enum-like columns (D1). `check` and
  `run` receive the limits for the call (`{ timeoutMs, rowCap }`). The engine
  compares the cost from `check` with `limits.maxQueryCost` and raises
  `QUERY_TOO_EXPENSIVE` itself.
* `Generator` (`model`, `promptHash`, `generate`) and `Reviewer` (`review`).
  Both take `{ timeoutMs, signal }`.
* `SlimeStore`: the key-value Port (C13). It replaces the sandbox's
  `HandlerStore` and PR #7's `SLIME_META_TABLE`.
* `SandboxRunner`: exported as a type. In v1 core always uses its own QuickJS
  runner, and there is no option to pass another.

Also exported: `SlimeError`, `SlimeConfigError`, the error codes,
`DEFAULT_TIERS` and `DEFAULT_LIMITS`.

## 6. Package layout

Every pluggable part is a port folder: `types.ts` holds the contract, each
implementation has its own folder beneath it, and `testing/` has its contract
suite. Restructured on 2026-11-21; [src/README.md](src/README.md) is the map.

```
core/
├── package.json          # @slime-cloud/core, "exports" per subpath, peerDeps optional
├── tsconfig.json         # typecheck only (noEmit)
├── tsconfig.build.json   # build → dist/, declarations on
├── bench/                # run.mjs + cases.mjs (npm run bench), protocol-cases.md
├── scripts/
│   └── check-pack.mjs    # what npm pack would ship (derived from exports and bin)
├── docs/                 # request-format.md
├── src/
│   ├── index.ts          # createSlime, SlimeConfig, errors, file and memory stores, types
│   ├── create-slime.ts   # startup: safety check, store init, dictionary
│   ├── shared/           # errors.ts, guards.ts, hash.ts
│   ├── config/           # slime-config.ts (the SlimeConfig class), options, defaults, validation
│   ├── connectors/       # PORT: types.ts; postgres/ → @slime-cloud/core/postgres
│   ├── models/           # PORT: types.ts, model-client.ts, roles.ts, prompts, schemas
│   │                     #   → @slime-cloud/core/models; claude/, groq/, offline/ each a subpath
│   ├── stores/           # PORT: types.ts, file-store.ts, memory-store.ts
│   ├── sandbox/          # PORT: types.ts; quickjs/ (runner and worker → @slime-cloud/core/shape-worker)
│   ├── engine/           # Slime instance, handler cache, generation, review loop, promotion;
│   │                     #   crystal/ (serving Crystal handlers), checks/ (SQL guard, limit check)
│   ├── request/          # parse.ts, shape.ts, params.ts, key.ts (§4)
│   ├── dictionary/       # dictionary rendered from metadata, glossary and rules (§4.4)
│   ├── crystallize/      # job, allowlist, check → @slime-cloud/core/crystallize (+ bin)
│   └── testing/          # contract suites and fakes → @slime-cloud/core/testing
└── test/                 # node:test, mirrors src/; support/ holds the database helpers
```

Dependencies:

| Package | Range | Kind | Needed from |
|---|---|---|---|
| `quickjs-emscripten` | ^0.32.0 | dependency | M2 |
| `zod` | ^4.6.7 | dependency | M4 (validating model output) |
| `pg` | ^8.23.1 | optional peer | M3 |
| `@anthropic-ai/sdk` | ^1.12.0 | optional peer | M4 |
| `acorn`, `acorn-walk` | ^8.19.0, ^8.3.5 | dependency of `/crystallize` only | M5 |

Groq is called with `fetch`, so it needs no SDK. The main entry depends only
on `quickjs-emscripten` (and `zod` from M4).

## 7. Milestones

The per-milestone file lists record what was built at the time; files moved
in the 2026-11-21 restructure, and §6 has the current layout.

Each milestone ends with green tests and a commit. Where a sandbox test file
is named, its cases are copied and adapted; matching the sandbox is not a
goal. Before a milestone starts, its row gets the files it creates or changes
(including `package.json` exports, `test/package.test.ts`,
`scripts/check-pack.mjs` and `.github/workflows/ci.yml`) and its test cases.

| # | Milestone | Done when | Status |
|---|---|---|---|
| M0 | **Skeleton.** Root `package.json` with workspaces, core `package.json` with an exports map, `tsconfig`, `node:test`, a CI job "Core tests". | `npm test -w @slime-cloud/core` runs; `npm pack` builds a tarball; CI is green. | done |
| M1 | **Request, contracts and pure parts.** Request parsing, intent normalization and the request key (§4); output notation with `date`/`datetime`; Ports and `SlimeError`; SQL guard and lint; `SlimeConfig` with defaults, validation and `glossary`. | `request`, `shape`, `params`, `key`, `sql`, `config` and `package` tests pass. | done |
| M2 | **Engine, Gas path.** `createSlime` and the instance API (`query`, `flush`, `close`, `evict`, `handlers`, `stats`; `onEvent` with `generated`, `warning` and `error`), the `memory` and `file` stores and the shared store contract test, offline generator, the shaping sandbox with the QuickJS worker, coalescing, rate limits, locked mode, typed and nullable parameters (R4, R5), the limit check (R6), the R7 warning. Engine rules below. | The M2 tests below pass with no database; no core test is skipped because a database is missing; no `config` singleton anywhere. | done |
| M3 | **Postgres connector.** Connector with the startup safety check and enum values from the catalog, which the M2 dictionary renders (§4.4). CI gets a Postgres service using `sandbox/db/init.sql` (roles and seed data). | `postgres.test.ts` cases pass against Postgres in CI (database tests require `REQUIRE_DB=1` in CI rather than skipping); the file and memory stores pass the shared contract test; changing `rules` changes the dictionary and regenerates handlers in explore mode. | done |
| M4 | **Models and Liquid.** Claude and Groq generators and reviewers with prompts updated for §4 (nullable parameters, the dictionary); the review loop; promotion to Liquid (rule below); `reviewed` and `promoted` events. | Review and promotion tests pass; one live run against Groq or Claude (`npm run bench` with `GROQ_API_KEY` or `ANTHROPIC_API_KEY`). | built; live run pending |
| M5 | **Crystal.** Serving from an imported registry; the crystallize job writing `.mjs` modules with a generated index; the `check` command. | `crystal*.test.ts` ported; a hand-edited Crystal file fails `check`; the output passes the equivalence test. | done |
| M6 | **Use it as a package, and retire `sandbox/`.** An example app that installs the packed tarball and calls `slime.query()` from an endpoint; docs for the request format; the bench ported to run on core. The example takes over what `sandbox/` still provides: the demo server, the demo database (`db/init.sql` and its Docker Compose file, used by core's tests and CI) and the offline handlers. Then `sandbox/` is deleted, with its CI job. Publishing to npm is not part of v1. | The example (`examples/express`, its own lockfile, run in CI from the packed tarball) answers a query. The bench, ported to `core/bench/`, gets the 5 cases recorded as correct in `docs/product/concepts_brief.md` right, and refuses the 2 unsafe ones. Core's tests and CI use the moved demo database. `sandbox/` and its CI job are gone. | built; bench with a model pending |
| M7 | **Switch `platform/runtime` to the package** (with its owner). Drop the path mapping to `sandbox/src`; build the engine with `createSlime(new SlimeConfig(…))`; replace `DynamoHandlerStore` with a `SlimeStore` over the existing table that serves the items already there; keep `slime.flush()` before each response (C15). After the switch nothing compiles `sandbox/src`, so M6 can delete `sandbox/`. | The runtime's tests pass on the package; a deployed function answers from handlers stored by the new store. Handlers saved before the switch are still served. The previous deploy can be restored. | built; handler copy and deploy pending (runtime owner) |

**M2 engine rules.** `createSlime()` awaits `connector.safetyCheck()` (unsafe
credentials throw `SlimeConfigError`), `store.init()` and the dictionary, in
that order. Concurrent requests with the same handler key share one
generation, and its error goes to all of them. `maxGenerationsPerHour` is per
instance and counted over a fixed hour. Over the limit, requests fail with
`GENERATION_RATE_LIMITED` (`retryable: true`).

**M2 tests.** Engine tests run against a scripted fake connector
(`test/helpers.ts`: rows, cost, truncation) and a stub generator and reviewer.
Required cases:

* a repeat request is a cache hit, and different input values reuse the
  handler;
* one handler serves every combination of `null` filters;
* a parameter's type changing after its first non-null value gives
  `INVALID_REQUEST`;
* more rows than `limit` is a failed run;
* locked mode serves a stored handler and refuses to generate;
* concurrent identical requests share one generation;
* the hourly limit gives `GENERATION_RATE_LIMITED`.

**M2 files.** `src/create-slime.ts`; `src/engine/` (`slime-engine.ts`,
`handler-cache.ts`, `generate.ts`, `execute.ts`, `coalescer.ts`,
`generation-limits.ts`, `events.ts`, `types.ts`); `src/shaping/`;
`src/store/file-store.ts` and `memory-store.ts`; `src/dictionary/`;
`src/offline/`; `src/checks/limit.ts`; `package.json` (`./offline` export,
`quickjs-emscripten`); `scripts/check-pack.mjs`; tests `engine`, `shaping`,
`stores` (with `store-contract.ts`), `dictionary` and `package`. `flush()`
has nothing to wait for until M4 adds reviews and promotion writes.

**M3 files.** `src/postgres/` (`postgres-connector.ts`, `describe.ts`,
`enum-values.ts`, `safety.ts`, `database-errors.ts`, `index.ts`);
`ACCESS_DENIED` in `src/errors.ts` (a denied table or column, final like
`WRITE_REFUSED`); `package.json` (`./postgres` export, `pg` as optional peer
and dev dependency); `scripts/check-pack.mjs`; `.github/workflows/ci.yml`
(Postgres service, `REQUIRE_DB=1`); tests `postgres` (with `database.ts`),
`engine` (rules change) and `package`.

**M4 promotion rule.** A Gas handler with `gasToLiquidRuns` successful runs
inside `gasWindowMs` goes to the reviewer. Approved: promoted to Liquid and
saved. Rejected: revised with the reviewer's notes and reviewed again, up to
`maxReviews` reviews; a revision must pass the same checks on a recorded
input, and its runs start over. After `maxReviews` rejections it stays Gas,
marked `review: 'rejected'`. A review call that fails emits an `error` event
and is retried after the next run. With no reviewer configured, handlers are
promoted after the runs and marked `review: 'none'`. Reviews run one at a time
in the background; `flush()` waits for them and for the store writes.
`promptHash` is a hash of the provider name and its prompt text.

**M4 files.** `src/models/` (`prompts.ts`, `schemas.ts`); `src/claude/`
(`structured-call.ts`, `claude-models.ts`, `index.ts`); `src/groq/`
(`groq-client.ts`, `groq-models.ts`, `index.ts`); `src/engine/`
(`background.ts`, `review-loop.ts`, `lifecycle.ts`; `generate.ts` takes a
starting point for revisions); `package.json` (`./claude` and `./groq`
exports, `zod`, `@anthropic-ai/sdk` as optional peer, `npm run live`);
`scripts/live-run.mjs` (the live run: the built package, the demo database,
a real model as generator and reviewer); tests `promotion`, `groq` and
`package`.

**M5 decisions** (Proposed; they settle the items §9 listed before M5):

* **How the job gets its parts without env.** `crystallize({ connector,
  store, dir, optimizer?, minRuns?, limits? })` is a library function on
  `@slime-cloud/core/crystallize`. The app calls it from its own script, with
  the same config it builds for `createSlime()`.
* **The bin** is `slime-crystal check <dir>`. It only checks, so it needs no
  database, model or env.
* **The registry** is the generated `index.mjs`. It exports `crystals`, keyed
  by request key, each entry with `sql`, `params`, `shape` and the metadata
  the engine needs (`intent`, `output`, `paramTypes`, `schemaHash`,
  `review`). `index.d.mts` types it as `CrystalRegistry`. Files are `.mjs`,
  so they load as ES modules whatever the app's package type.
* **The manifest** (`manifest.json`, version 1) pins each module's sha256
  and holds everything the index is generated from. `check` re-runs the
  allowlist and the read-only lint on every module (so a re-pinned hand edit
  still fails), compares the index with one rendered from the manifest, and
  refuses modules missing from it.
* **The Optimizer** is a Port (`optimize(request, options)`). It sees only
  code, never the intent or data. `claude.optimizer` and `groq.optimizer`
  implement it. Without one, the Liquid code moves over unchanged if it passes
  the allowlist.
* **`crystalMinRuns`** is `crystallize()`'s `minRuns` option (default 10),
  not a config tier.
* **Crystal is keyed by request key**, like saved handlers. A Crystal handler
  made against another schema is served as it is, with one startup warning.

**M5 files.** `src/crystal/` (`types.ts`, `run-crystal.ts`); `src/crystallize/`
(`allowlist-rules.ts`, `allowlist.ts`, `module-format.ts`, `manifest.ts`,
`import-module.ts`, `equivalence.ts`, `crystallize.ts`, `check.ts`, `bin.ts`,
`index.ts`); the Optimizer Port in `src/ports.ts`, its prompt and schema in
`src/models/`, and `claude.optimizer` and `groq.optimizer`; `src/engine/`
(`meta.ts`; the engine serves Crystal first); `package.json` (`./crystallize`
export, `slime-crystal` bin, `acorn` and `acorn-walk`); tests
`crystal-allowlist`, `crystallize` and `package`.

**M6 files.** `examples/express/` (`src/app.mjs` with named routes and
a dev-only `POST /dev/query`, `src/config.mjs`, `src/server.mjs`,
`scripts/crystallize.mjs`, `test/app.test.mjs`, `offline-handlers.json`,
`db/init.sql` and `docker-compose.yml` copied from `sandbox/`, its own
lockfile); `core/docs/request-format.md`;
`core/bench/` (`cases.mjs`, `run.mjs`, `npm run bench`; it runs
offline too, which checks the bench but not a model); core's tests and CI
use the example's `db/init.sql`; `.github/workflows/ci.yml` (an "Example
app" job that installs the packed tarball, runs the example's tests and
`check:crystal`). `sandbox/` keeps its own copy of the demo database until it
is deleted.

**M7 decisions and files.** Built on this branch for the runtime owner's
review.

* **How the runtime depends on the package:** `"@slime-cloud/core":
  "file:../../core"`, bundled from its built `dist/`. CI and
  `platform/infra/platform/build.sh` build the core first.
* **Config:** `src/config.ts` maps the same env variable names the sandbox
  runtime read, so the SSM parameters don't change.
* **Store:** `DynamoSlimeStore` on the existing table, with sort keys
  `<ns>#<key>`. The core's store contract runs against it.
* **Handler copy:** `npm run migrate` copies the sandbox runtime's Liquid
  handlers into the core's format (request key, coarse types, inputs-only
  fixtures). The old items are left as they are, so rolling back means
  redeploying the previous bundle.
* **The Lambda flush is capped:** it waits up to `SLIME_FLUSH_LIMIT_MS`
  (5 s by default), because `flush()` now waits for reviews too and the
  function times out at 30 s.
* **IAM:** Query, GetItem, PutItem and DeleteItem (UpdateItem is no longer
  used).
* **The store contract test is exported** on `@slime-cloud/core/testing`,
  and core exports `handlerKeyFor(request)`.

Files: `platform/runtime/` (`src/config.ts`, `src/store-dynamodb.ts`,
`src/legacy-handlers.ts`, `src/migrate-cli.ts`, `src/app.ts`,
`src/lambda.ts`, `scripts/build.mjs`, `offline/handlers.json`, tests,
README); `platform/infra/platform/` (`build.sh`, the IAM statement in
`runtime.tf`); `.github/workflows/` (no `sandbox` job; the runtime job builds
the core; terraform triggers on `core/**`); core
(`src/testing/`, `handlerKeyFor`). `sandbox/` is deleted.

**M7 checklist (with the runtime owner):**

* how the runtime depends on the package (workspace, `file:` or tarball);
* changes to `scripts/build.mjs` (the shape worker and the QuickJS WASM);
* how each env var maps to `SlimeConfig`;
* one Slime instance per tenant, cached across invocations;
* `app.ts` calls mapped to the §5 API;
* the `DynamoHandlerStore` tests replaced;
* CI: the runtime job stops installing `sandbox/` and checking
  `sandbox/src`, so M6 can delete it.

## 8. Risks and limits

* **Several processes writing one store.** Writes are last-writer-wins, so
  run counts and promotions can be lost. Separate hosts with their own
  `.slime/` drift apart. Explore with one process, or use a custom store
  built for several writers.
* **Authorization comes from `input`.** An app that passes `req.body` to
  `query()` lets any client read any row `slime_reader` can see. The README
  and the example app follow R11.
* **The deployed runtime still runs the sandbox engine until M7 is deployed.**
  The code on this branch is switched and `sandbox/` is deleted, but the
  live Lambda keeps the old bundle until the handler copy runs and the
  platform stack is applied. Until then it serves the old items, which the
  copy leaves untouched.
* **The worker file in a built package.** The worker is written in TS so tsc
  emits it. It is resolved with `new URL('./shape-worker.js',
  import.meta.url)`, and `check-pack.mjs` requires it from M2.
* **Locked mode serves handlers made against another schema.** A handler
  records the schema hash it was made with. If production's schema differs,
  locked mode still serves it and warns once at startup. A query that no
  longer fits fails with `QUERY_ERROR`. Regenerate in development after a
  migration.
* **Crystal checks move from startup to CI (C10).** Crystal runs in the app
  process outside the shaping sandbox, with no CPU or memory limit; the
  allowlist is its only boundary. If an app skips `slime-crystal check` in
  CI, an edited module runs unchecked. The README must say this plainly, and
  the example app's CI runs `check`.
* **Token cost grows with the schema.** The whole dictionary goes into every
  generation. v1 has no table selection.

## 9. Next decision

M0 to M3 and M5 are done; M4, M6 and M7 are built. Still to decide:

* **Still Proposed, built as proposed in M2 and M3:** R4, R5, R7, R11, C12, C15 and
  C4's class shape. They stand unless someone objects.
* **With the runtime owner:** Slime Cloud's production mode (explore,
  locked, or chosen per tenant). `SLIME_MODE` sets it either way; the
  handler copy makes locked mode safe to switch to.
