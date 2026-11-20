# @slime-cloud/core: library plan

* **Status:** draft, being decided step by step
* **Date:** 2026-11-20
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

## 2. What we start from

| Source | What it says about core |
|---|---|
| `concepts_brief.md` | Library first (`@slime/core`), standalone server later. Read-only, Postgres, `{ intent, input, output }`, Gas → Liquid → Crystal. First next step: "turn the sandbox into the library plus an example app". |
| `sandbox/` on `main` | Working engine, about 88 tests. Gas, Liquid in Postgres, background review, Crystal (PR #6), offline/Groq/Claude providers. Configured through a global `config` that reads env and `.env`. |
| PR #7 (open) | Layers: core → server → platform. Name `@slime-cloud/core` at `oss/packages/core`. Its plan moves `sandbox/` there with `git mv`, and adds `SLIME_META_TABLE`. Lists "config injection instead of the module singleton" as later work. |
| `chore/gas-v0-plan`, `onboarding` | The other direction (Bun, SQLite, named intents, writes). Not the base for core. Useful later for the write path (`EffectSink`). |
| `slime-cloud/runtime/` on `main` | **The first consumer of core.** Slime Cloud's runtime on AWS Lambda with handlers in DynamoDB (table `slime-handlers`, partition key `tenantId`, sort key `artifactKey`). It compiles `sandbox/src` through a path mapping and imports deep modules (`@slime-cloud/core/engine.js`, `config.js`, `store.js`). It must set env before importing, because `config` reads env at import time, and it flushes store writes before every response, because Lambda freezes the process afterwards. Its own `DynamoHandlerStore` implements the sandbox's `HandlerStore`. |

Where this plan differs from PR #7: PR #7's Tasks 1–3 move the sandbox as is.
This plan builds core as a library at the same path instead. Server and
platform (PR #7 Tasks 2 and 4) then build on `createSlime()`. **Agree this
with the PR #7 author before M0 lands.**

`slime-cloud/runtime` moves to the package (agreed with the team; its README
still says `sandbox/` gets published, which is now out of date). The runtime
changes in a few places (§7, M7):

* it uses `createSlime(new SlimeConfig(…))` instead of setting env before
  importing;
* it uses the `dynamodb` store type instead of its own `DynamoHandlerStore`;
* it imports the package instead of the path mapping to `sandbox/src`.

## 3. Decisions

Status: **Decided**, **Proposed** (default unless someone objects) or
**Open** (we decide together next).

| # | Question | Proposal | Status |
|---|---|---|---|
| C1 | Name and location | `@slime-cloud/core` in `oss/packages/core/`, inside npm workspaces at the repo root (PR #7 D10). | Decided |
| C2 | Start from scratch or move the sandbox? | New package. Core is the only engine; `sandbox/` is frozen and not used (team agreement, 2026-11-20). Its code and tests are a quarry to copy from, not a reference to match. It is deleted once `slime-cloud/runtime` has moved to the package (M7). | Decided |
| C3 | Runtime | v1: Node ≥ 22, ESM only. Built so that other runtimes (Bun, Deno, edge) can be added later without touching the engine. Runtime-specific code stays behind Ports: the shaping sandbox goes behind a new `SandboxRunner` Port (today a QuickJS worker thread), and database drivers stay behind `Connector`. The engine uses only `node:*` modules that Bun and Deno also provide. | Decided |
| C4 | Configuration | A `SlimeConfig` class. The app creates it and adds the parts it needs: connector, generator, store, limits. Each part can come from env, a secrets store or anywhere else in the app. The class fills defaults, validates everything at once (reporting every problem, not just the first), and is immutable; `config.with({...})` returns a changed copy for tests. Core never reads `process.env` or `.env`. | Decided (class shape: Proposed) |
| C5 | Entry point | Three steps in the app: create a connector (where data comes from), create a Slime instance with `createSlime(config)`, then call `slime.query()` inside any endpoint. The instance also has `handlers()`, `stats()`, `evict(id)`, `flush()` and `close()`. | Decided |
| C6 | Locked mode | Locked means no `generator` is passed. Then no model client is ever imported, by construction. An explicit `mode` setting can be added later without breaking this. | Decided |
| C7 | Packaging of adapters | Subpath exports from one package: `@slime-cloud/core/postgres`, `/dynamodb`, `/claude`, `/groq`, `/offline`. Model SDKs and database drivers are optional peer dependencies. | Decided |
| C8 | What ships | Compiled JS and `.d.ts` in `dist/` (built with `tsc`), plus the shape worker file. Not TS source. | Decided |
| C9 | HTTP | No HTTP in core. The app calls `slime.query()` from its own endpoint in any framework. A thrown `SlimeError` carries `status` and `toJSON()`, so the endpoint can return it directly. Admin data comes from methods only (`handlers()`, `stats()`, `evict()`); exposing and protecting them over HTTP is up to the app or `@slime-cloud/server`. | Decided |
| C10 | Crystal | Crystal handlers are ordinary modules in the app's own code. The crystallize job writes TS or JS (a config setting) plus a generated `index` and a manifest. The app imports the index and passes it as `crystal` in `SlimeConfig`; leaving it out (or `false`) turns Crystal off. Because the code is compiled with the app, safety is checked when the job writes it (allowlist, SQL lint, equivalence test on recorded runs) and by a `check` command in the app's CI, which re-parses the sources and compares manifest hashes. Core doesn't re-check at startup. The job and `check` are a separate entry (`@slime-cloud/core/crystallize`, plus a bin), so the runtime never imports them. | Decided |
| C11 | Observability | An `onEvent(event)` option (generated, promoted, reviewed, error, timings, tokens). Core doesn't log on its own. Metering builds on this later. | Decided |
| C12 | Out of scope for core v1 | Writes, tenancy, connectors other than Postgres, Redis, semantic matching. | Proposed |
| C13 | Store contract | A small key-value Port, `SlimeStore`: `get(ns, key)`, `put(ns, key, value)`, `list(ns, prefix?)`, `delete(ns, key)`. Values are JSON. Namespaces: `handlers`, `dictionary`. The engine builds the keys and filters by prefix (schema, glossary, prompt, model), so a backend is only a mapping to 4 calls. It replaces the sandbox's domain-shaped `HandlerStore`. | Decided |
| C14 | Choosing a store | The `store` option in `SlimeConfig` picks a built-in store by config, or takes any object that implements `SlimeStore`. Built in: `file` (the default), `memory`, `postgres` and `dynamodb` (§4.8). Files and memory have no dependencies. Postgres and DynamoDB ship in core as optional adapters: their drivers (`pg`, `@aws-sdk/client-dynamodb`) are optional peer dependencies, loaded only when that store is chosen. | Decided |
| C15 | Background work on serverless | Core runs work off the request path: store writes, background reviews and the dictionary build (D4). On Lambda the process is frozen after each response, so nothing runs in between. `slime.flush()` waits for queued store writes (cheap; call it before every response on Lambda). `slime.settled()` waits for everything, including reviews and the dictionary build. Work that is cut off resumes on the instance's next invocation, or is redone later; it is never half-saved. | Proposed |

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

The more precisely the intent is written, the more precise the generated
query. If a result is wrong, the developer rewords the intent: that is a new
key, so Slime generates again, and the old handler expires unused.

A structured protocol (`from`, `where` with operators, `groupBy`, paths) was
designed and dropped on 2026-11-20. It turned the request into a query
language to learn, and the mistakes seen so far were about meaning, which
structure doesn't fix. It is in this file's git history, and the 35 cases it
was tested on stay in [docs/protocol-cases.md](docs/protocol-cases.md) as
benchmark material.

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

### 4.3 Decisions

| # | Question | Decision | Status |
|---|---|---|---|
| R1 | What does a request contain? | `{ intent, input?, output }`. `intent` and `output` are required; `input` is optional. | Decided |
| R2 | What is hashed? | All three fields: the normalized `intent` (R3), the input signature (R4) and `output`. Different request = different key = a new generation. | Decided |
| R3 | How is `intent` normalized? | Unicode NFKC, lowercase, repeated whitespace collapsed to one space, trimmed, trailing `.!?;:,` removed. Nothing more: no synonyms, no stemming, no model. A key must be deterministic. | Decided |
| R4 | What of `input` is hashed? | The key **names** only, sorted. Never the values, so `{ limit: 5 }` and `{ limit: 50 }` share a handler. Types are not in the key either: the handler records each parameter's coarse type (`string`, `number`, `boolean`, `list`) from the first non-null value it sees, and a later value of another type fails with `INVALID_REQUEST`. So `5` and `5.5` share a handler, and a parameter behaves like a typed route parameter. | Proposed |
| R5 | Optional filters (`null`)? | Every parameter may be `null`, meaning "not given". The key doesn't change, and the generator is told every parameter is nullable, so it writes `($1 IS NULL OR country = $1)`. A frontend with 5 optional filters always sends all 5 keys and gets **one** handler, not 32. Leaving a key out entirely is a different request. | Proposed |
| R6 | Paging? | `input.limit` and `input.offset` are reserved: non-negative integers. After each run Slime checks, without a model, that the top-level list has at most `limit` rows; a failed check is a failed run. | Decided |
| R7 | Values written into the intent? | In explore mode, an intent containing literals (a number with 2+ digits, quoted text, an email, an id) is an `INVALID_REQUEST` error that says to move the value into `input`. In locked mode it can't generate anyway. | Proposed |
| R8 | Explore vs locked in production? | Generation is for development. In explore mode anyone who can send a request (including from a browser's devtools) can make Slime generate a new read query against everything `slime_reader` sees. So the documented setup is: **explore in development, locked in production** (C6), serving only handlers that were saved (Liquid) or crystallized. Intents then act as named routes. | Decided |
| R9 | Can the developer see what was generated? | Yes. `meta` carries `sql`, `shapeJs` and the model's `assumptions`. On every new generation core emits an `onEvent` event (C11) with them, so a dev setup can print it to the console. A wrong answer is only fixable if it's visible. | Decided |
| R10 | Matching by meaning (embeddings, a model normalizing the text)? | No. A non-deterministic key is worse than one extra generation. | Decided |

### 4.4 Startup dictionary

Heavy context work happens once, when the app starts, not on every
generation. `createSlime()` starts building a **dictionary** of the database
in the background. `slime.query()` generates against it.

| # | Question | Decision | Status |
|---|---|---|---|
| D1 | What does Slime read from the database? | Metadata only, never row data: tables, columns, types, comments, primary and foreign keys, and the allowed values of enum-like columns. Those come from the catalog (Postgres enums and `CHECK … IN (…)` constraints), not from the rows. | Decided |
| D2 | Who writes the dictionary? | A model, in a step inside `createSlime()`. It reads the metadata plus the app's `glossary` and writes **SQL notes** for this schema, for example "group by ids, not names", "amounts are integer cents", "`issued_at` is the invoice date". The app can add its own `rules` in `SlimeConfig`. They are stored next to the model's notes, and the app's rules win when the two conflict. | Decided |
| D3 | Where is it stored? | In the same store as Liquid handlers (C13), namespace `dictionary`, keyed by the hash of its inputs (D6). The store can be files, memory, Postgres or DynamoDB; core doesn't care which. | Decided |
| D4 | Blocking or background? | Background. `createSlime()` returns at once. | Decided |
| D5 | What happens to requests before it's ready? | Cache hits (Liquid and Crystal loaded at startup) are served immediately; they don't need the dictionary. New generations wait for it. If building it fails, core emits an `onEvent` error and generations go ahead with the plain metadata. | Proposed |
| D6 | When is it rebuilt? | When its inputs change: the metadata hash, the `glossary`, the `rules` or the model that writes the notes. Otherwise it is loaded from the store. Its hash is part of every Gas and Liquid handler key, so a rebuilt dictionary regenerates the handlers that depend on it. | Proposed |
| D7 | Locked mode? | Only loaded, never built: locked mode has no model. If none is stored, locked mode serves its saved handlers without one. | Proposed |
| D8 | Can the developer see it? | `slime.dictionary()` returns it, and building it emits an `onEvent` event with the notes, so a dev setup can print them. | Proposed |

### 4.5 What the model sees

* the dictionary (§4.4): metadata, glossary, the model's SQL notes and the app's
  rules;
* the intent;
* the input key names, with their types when known;
* `output`.

It never sees input values or rows.

### 4.6 What comes back

* **`data`** matches `output` exactly: no missing keys, no extra keys, right
  types and date formats. Otherwise the run fails with `SHAPE_MISMATCH`.
* **`meta`** has:
  * `tier` and `cache`;
  * `timingsMs`;
  * `sql`, `shapeJs` and `assumptions`;
  * `warnings`;
  * `review`.
* **Errors** are thrown as `SlimeError`: `{ code, message, retryable }` with an
  HTTP `status` (C9).

### 4.7 Changes from the sandbox

* `output` becomes required.
* Input types move out of the key and into the handler (R4), so `5` and `5.5`
  share a handler.
* Nullable parameters (R5): one handler for any combination of optional
  filters.
* Reserved `limit`/`offset` with a check after each run (R6).
* `date` and `datetime` leaves; a top-level object means one row (§4.2).
* Literals in the intent are an error in explore mode, not just a warning
  (R7).
* Locked is the documented production mode (R8).
* The startup dictionary, built by a model in the background (§4.4).

### 4.8 Storage: chosen in the config

Core depends on no database for its own storage. Everything it keeps (Liquid
handlers with their fixtures, run counts, the dictionary) goes through the
`SlimeStore` Port (C13):

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

The engine builds the keys: `handlers` / `${scope}#${requestKey}`, where
`scope` is a 16-character hash of the schema, dictionary, prompt and model
hashes. Loading "every handler for this scope" is then one
`list('handlers', scope + '#')`, and keys stay short and safe for file
names.

The app picks the store in `SlimeConfig`:

```ts
store: { type: 'file', dir: './.slime' }                         // the default
store: { type: 'memory' }                                         // tests
store: { type: 'postgres', url: process.env.SLIME_STORE_URL!, table: 'slime_store' }
store: { type: 'dynamodb', table: 'slime-store', region: 'eu-central-1', prefix: 'acme' }
store: myRedisStore                                               // anything implementing SlimeStore
```

| `type` | Dependencies | Good for |
|---|---|---|
| `file` (default) | none (`node:fs`) | local development, and production in locked mode with `.slime/` committed to git |
| `memory` | none | tests |
| `postgres` | `pg` (optional peer; the Postgres connector needs it anyway) | self-hosting with several instances, in the app's own database or another one |
| `dynamodb` | `@aws-sdk/client-dynamodb` (optional peer) | AWS deployments, and Slime Cloud |
| a custom object | whatever it uses | anything else: Redis, S3, an internal service |

**Loading.** Core imports the Postgres or DynamoDB adapter only when that
type is chosen. If its driver isn't installed, `SlimeConfig` fails with one
clear message, for example "store type 'postgres' needs the `pg` package:
`npm install pg`".

**Why files are the default.** They follow the explore → locked flow (R8).
In development, handlers and the dictionary are written to `./.slime/`. The
developer commits that folder, like Crystal. In production, locked mode only
reads it: no database for Slime's own state, and no model. A team that
doesn't want state in git picks `postgres` or `dynamodb`; in production they
then work in locked mode too, against a store filled during development.

**The file store's rules:**

* one JSON file per key: `.slime/<ns>/<key>.json`;
* writes go to a temporary file first, then a rename, so a crash never leaves
  half a file;
* one writer: in locked mode Slime never writes to the store, and run counts
  stay in memory.

**Postgres store:**

* one table, by default `slime_store`, with columns `(ns, key, value jsonb,
  updated_at)` and primary key `(ns, key)`;
* `list` is `WHERE ns = $1 AND key LIKE $2 || '%'`;
* `init()` creates the table if it's missing. The store's user needs a schema
  it may create tables in, and must not be the read-only connector user.

**DynamoDB store:**

* one table with a string partition key and a string sort key;
* partition key = `prefix`, which is the tenant in Slime Cloud and a fixed
  value such as `default` elsewhere;
* sort key = `${ns}#${key}`;
* the JSON goes in one attribute;
* `list(ns, prefix)` is one `Query` on the partition with
  `begins_with(sk, ns + '#' + prefix)`;
* the attribute names are options, defaulting to `pk` and `sk`;
* the table is created outside Slime (Terraform, CDK, console). `init()` only
  checks that it exists and has this key schema.

Slime Cloud's existing table (`slime-handlers`, keys `tenantId` and
`artifactKey`, in `infra/aws/platform/runtime.tf`) works as it is:

```ts
store: { type: 'dynamodb', table: 'slime-handlers', prefix: tenantId,
         keys: { partition: 'tenantId', sort: 'artifactKey' } }
```

Rows written by today's `DynamoHandlerStore` don't start with
`handlers#`, so the new store ignores them. They can be deleted after the
switch, and the handlers are regenerated.

Because the tenant is the partition key, core never sees tenants, and an IAM
condition on `dynamodb:LeadingKeys` keeps each tenant's role in its own
partition (PR #7 §6).

**One contract test** runs against every store, the built-in ones and any
custom store, so an adapter either passes or it doesn't.

**Value size.** DynamoDB items are limited to 400 KB, so core keeps every
value under a documented limit (300 KB) for every store:

* each handler's `history` and `fixtures` are capped;
* the dictionary is stored as one entry per table plus an index entry, not
  one big value.

## 5. Draft public API

This is the target for C4–C10, and it changes as we decide them.

```ts
import { createSlime, SlimeConfig } from '@slime-cloud/core';
import { postgresConnector } from '@slime-cloud/core/postgres';
import { claude } from '@slime-cloud/core/claude';

// The app decides where values come from: env here, but any source works.
const config = new SlimeConfig({
  connector: postgresConnector({ url: process.env.READER_URL! }), // required; refuses to start if the user can write
  store: { type: 'postgres', url: process.env.SLIME_STORE_URL! },  // default: { type: 'file', dir: './.slime' } (§4.8)
  generator: claude.generator({ apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-haiku-5-5' }), // omit = locked mode
  reviewer: claude.reviewer({ apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-opus-5-5' }),    // omit = no review
  crystal: crystals,                // import { crystals } from './slime-crystal/index.js'; omit = off
  glossary: { revenue: 'sum of paid invoices, in cents' },        // optional; meaning of the app's words (§4.4)
  rules: ['Count only paid invoices as revenue.'],                 // optional; added to the model's SQL notes (D2)
  tiers: { gasToLiquidRuns: 3, gasWindowMs: 3_600_000 },           // optional, defaults shown
  limits: { rowCap: 1_000, statementTimeoutMs: 2_000, maxGenerationsPerHour: 200 },
  onEvent: (e) => console.log(JSON.stringify(e)),
}); // throws one SlimeConfigError listing every problem

const slime = await createSlime(config);

// Inside any endpoint, in any framework. Express shown here.
app.post('/api/data', async (req, res) => {
  try {
    res.json(await slime.query(req.body)); // { data, meta }
  } catch (err) {
    if (err instanceof SlimeError) return res.status(err.status).json({ error: err.toJSON() });
    throw err;
  }
});

await slime.close(); // on shutdown
```

Contracts (Ports) that core exports, unchanged from the sandbox unless noted:

* `Connector`: `describe`, `check`, `run`, `safetyCheck`, `close`. The
  schema from `describe` may gain the allowed values of enum-like columns
  (§4.4);
* `Generator` and `Reviewer`;
* `SlimeStore`: the key-value Port (C13). It replaces the sandbox's
  `HandlerStore` and PR #7's `SLIME_META_TABLE`: a tenant's isolation is a
  constructor option of the store (a directory, a table, a partition key);
* `SlimeError` and its error codes.

## 6. Package layout (target)

```
oss/packages/core/
├── package.json        # @slime-cloud/core, "exports" per subpath, peerDeps optional
├── tsconfig.json       # build → dist/, declarations on
├── src/
│   ├── index.ts        # createSlime, SlimeConfig, types, SlimeError
│   ├── config.ts       # SlimeConfig: defaults, validation, with()
│   ├── engine/         # engine, tiers, review loop, coalescing, rate limits
│   ├── request/        # parsing, normalization, request key (§4)
│   ├── dictionary/     # startup dictionary (§4.4)
│   ├── checks/         # shape, sql guard, lint, limit check (R6)
│   ├── sandbox/        # SandboxRunner Port + QuickJS worker (shape-worker.mjs)
│   ├── crystal/        # Crystal registry types; serving crystal handlers
│   ├── store/          # SlimeStore Port, file and memory stores, store config, contract test
│   ├── postgres/       # connector + postgres store → @slime-cloud/core/postgres
│   ├── dynamodb/       # dynamodb store           → @slime-cloud/core/dynamodb
│   ├── claude/         # generator + reviewer → @slime-cloud/core/claude
│   ├── groq/           #                      → @slime-cloud/core/groq
│   ├── offline/        #                      → @slime-cloud/core/offline
│   └── crystallize/    # job, allowlist, check → @slime-cloud/core/crystallize (+ bin)
└── test/
```

## 7. Milestones

Each milestone ends with green tests and a commit. Where a sandbox test file
is named, its cases are copied and adapted; matching the sandbox is not a
goal.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Skeleton.** Root `package.json` with workspaces, core `package.json` with an exports map, `tsconfig`, `node:test`, a CI job "Core tests". | `npm test -w @slime-cloud/core` runs; `npm pack` builds a tarball; CI is green. |
| M1 | **Request, contracts and pure parts.** Request parsing, intent normalization and the request key (§4); output notation with `date`/`datetime`; Ports and `SlimeError`; SQL guard and lint; `SlimeConfig` with defaults, validation and `glossary`. | `units.test.ts` ported and adjusted for §4.7. |
| M2 | **Engine, Gas path.** `createSlime`, `query`, the `SlimeStore` Port with the `memory` and `file` stores and the shared store contract test, offline generator, `SandboxRunner` with the QuickJS worker, coalescing, rate limits, locked mode, typed and nullable parameters (R4, R5), the limit check (R6). | `engine.test.ts` and `sandbox.test.ts` ported; one handler serves every combination of `null` filters; no `config` singleton anywhere. |
| M3 | **Postgres, DynamoDB and the dictionary.** Connector with the start-up safety check and enum values from the catalog; the `postgres` and `dynamodb` stores; the background dictionary build (§4.4). | `postgres.test.ts` and `persistence.test.ts` ported; both stores pass the shared contract test (DynamoDB against DynamoDB Local in Docker); a missing driver gives the install message; a restart loads the dictionary instead of rebuilding it; changing `rules` rebuilds it. |
| M4 | **Models and Liquid.** Claude and Groq generators and reviewers with prompts updated for §4 (nullable parameters, the dictionary); the review loop; promotion to Liquid. | Review and promotion tests pass; one live run against Groq or Claude. |
| M5 | **Crystal.** Serving from an imported registry; the crystallize job writing TS or JS; the `check` command. | `crystal*.test.ts` ported; a hand-edited Crystal file fails `check`; TS and JS output both pass the equivalence test. |
| M6 | **Use it as a package.** An example app in `oss/examples/` that installs the packed tarball and calls `slime.query()` from an endpoint; docs for the request format; the bench ported to run on core. | The example answers a query from the tarball; the bench is at least as correct as the sandbox's. |
| M7 | **Switch `slime-cloud/runtime` to the package** (with its owner). Drop the path mapping to `sandbox/src`; build the engine with `createSlime(new SlimeConfig(…))`; use the `dynamodb` store type on the existing table; keep `slime.flush()` before each response (C15). Then retire `sandbox/`: nothing imports it any more. | The runtime's tests pass on the package; a deployed function answers from handlers stored by the new store. |

## 8. Risks

* **The file store in production with explore mode.** Several instances
  writing to one `.slime/` directory would overwrite each other. Locked mode
  never writes; explore mode in production is against R8. A server with
  several instances in explore mode must use a shared store (Postgres,
  DynamoDB).

* **The runtime runs on frozen sandbox code until M7.** `slime-cloud/runtime`
  keeps compiling `sandbox/src` until it moves to the package. Bugs found there
  are fixed in core, not in the sandbox, so M7 shouldn't wait too long.
* **The worker file in a built package.** `shape-worker.mjs` is resolved
  relative to the module. It must be copied into `dist/` and tested from the
  packed tarball (M6), not only from the source tree.
* **Prompt hash depends on the provider.** Today
  `promptHashFor(config.provider)` is part of the store scope. With injected
  generators, each generator has to report its own prompt hash and model.
  Otherwise locked mode won't find saved handlers again (the bug fixed in
  PR #6).
* **PR #7 overlap.** Its Tasks 1–3 move the same code to the same path.
* **Crystal checks move from startup to CI (C10).** Crystal runs in the app
  process without a sandbox. If an app skips `check` in CI, an edited module
  runs unchecked. The README must say this plainly, and the example app's CI
  runs `check`.
* **Checking TS output.** The allowlist parses JS, so TS has to be
  type-stripped first. Plan to use Node's built-in type stripping; confirm the
  exact API and minimum Node version at M5.

## 9. Next decision

C1–C11 and most of §4 are decided. Still to do:

* R4, R5, R7, D5–D8 and C15 (Proposed);
* confirm C12 (what's out of scope);
* agree with the PR #7 author that core is built at `oss/packages/core` (§2).

M0, the skeleton, doesn't depend on any of these and can start now.
