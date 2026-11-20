# @slime-kit/core: library plan

* **Status:** draft, being decided step by step
* **Date:** 2026-11-20
* **Owner:** Konstantin (core only; server and platform are owned by others)

## 1. Goal

Turn the sandbox prototype into a library that can be packaged, installed
and used:

* `npm install @slime-kit/core`;
* configure it in code;
* call `slime.query()` inside any Node app.

We build a new package instead of moving `sandbox/`. Each sandbox module is
brought over on purpose, together with its tests, and reshaped into a
library: options in, no global state, no `.env` reading.

## 2. What we start from

| Source | What it says about core |
|---|---|
| `concepts_brief.md` | Library first (`@slime/core`), standalone server later. Read-only, Postgres, `{ intent, input, output }`, Gas → Liquid → Crystal. First next step: "turn the sandbox into the library plus an example app". |
| `sandbox/` on `main` | Working engine, about 88 tests. Gas, Liquid in Postgres, background review, Crystal (PR #6), offline/Groq/Claude providers. Configured through a global `config` that reads env and `.env`. |
| PR #7 (open) | Layers: core → server → platform. Name `@slime-kit/core` at `oss/packages/core`. Its plan moves `sandbox/` there with `git mv`, and adds `SLIME_META_TABLE`. Lists "config injection instead of the module singleton" as later work. |
| `chore/gas-v0-plan`, `onboarding` | The other direction (Bun, SQLite, named intents, writes). Not the base for core. Useful later for the write path (`EffectSink`). |

Where this plan differs from PR #7: PR #7's Tasks 1–3 move the sandbox as is.
This plan builds core as a library at the same path instead. Server and
platform (PR #7 Tasks 2 and 4) then build on `createSlime()`. **Agree this
with the PR #7 author before M0 lands.**

## 3. Decisions

Status: **Decided**, **Proposed** (default unless someone objects) or
**Open** (we decide together next).

| # | Question | Proposal | Status |
|---|---|---|---|
| C1 | Name and location | `@slime-kit/core` in `oss/packages/core/`, inside npm workspaces at the repo root (PR #7 D10). | Decided |
| C2 | Start from scratch or move the sandbox? | New package. Port modules one at a time, each with its tests. The sandbox isn't touched until core reaches parity, then it's retired (M6). | Decided |
| C3 | Runtime | v1: Node ≥ 22, ESM only. Built so that other runtimes (Bun, Deno, edge) can be added later without touching the engine. Runtime-specific code stays behind Ports: the shaping sandbox goes behind a new `SandboxRunner` Port (today a QuickJS worker thread), and database drivers stay behind `Connector`. The engine uses only `node:*` modules that Bun and Deno also provide. | Decided |
| C4 | Configuration | A `SlimeConfig` class. The app creates it and adds the parts it needs: connector, generator, store, limits. Each part can come from env, a secrets store or anywhere else in the app. The class fills defaults, validates everything at once (reporting every problem, not just the first), and is immutable; `config.with({...})` returns a changed copy for tests. Core never reads `process.env` or `.env`. | Decided (class shape: Proposed) |
| C5 | Entry point | Three steps in the app: create a connector (where data comes from), create a Slime instance with `createSlime(config)`, then call `slime.query()` inside any endpoint. The instance also has `handlers()`, `stats()`, `evict(id)`, `flush()` and `close()`. | Decided |
| C6 | Locked mode | Locked means no `generator` is passed. Then no model client is ever imported, by construction. An explicit `mode` setting can be added later without breaking this. | Decided |
| C7 | Packaging of adapters | Subpath exports from one package: `@slime-kit/core/postgres`, `/claude`, `/groq`, `/offline`. Model SDKs are optional peer dependencies. | Decided |
| C8 | What ships | Compiled JS and `.d.ts` in `dist/` (built with `tsc`), plus the shape worker file. Not TS source. | Decided |
| C9 | HTTP | No HTTP in core. The app calls `slime.query()` from its own endpoint in any framework. A thrown `SlimeError` carries `status` and `toJSON()`, so the endpoint can return it directly. Admin data comes from methods only (`handlers()`, `stats()`, `evict()`); exposing and protecting them over HTTP is up to the app or `@slime-kit/server`. | Decided |
| C10 | Crystal | Crystal handlers are ordinary modules in the app's own code. The crystallize job writes TS or JS (a config setting) plus a generated `index` and a manifest. The app imports the index and passes it as `crystal` in `SlimeConfig`; leaving it out (or `false`) turns Crystal off. Because the code is compiled with the app, safety is checked when the job writes it (allowlist, SQL lint, equivalence test on recorded runs) and by a `check` command in the app's CI, which re-parses the sources and compares manifest hashes. Core doesn't re-check at startup. The job and `check` are a separate entry (`@slime-kit/core/crystallize`, plus a bin), so the runtime never imports them. | Decided |
| C11 | Observability | An `onEvent(event)` option (generated, promoted, reviewed, error, timings, tokens). Core doesn't log on its own. Metering builds on this later. | Decided |
| C12 | Out of scope for core v1 | Writes, tenancy, connectors other than Postgres, Redis, semantic matching. | Proposed |

## 4. Request format and matching

`slime.query(request)` takes `{ input, output }` and returns `{ data, meta }`.
The caller describes the request in its own words. Names don't have to match
the database: the model maps each name to the closest table, column or
expression it can see. That mapping is the point of Slime. The cases this
format was tested against are in
[docs/protocol-cases.md](docs/protocol-cases.md).

```jsonc
{
  "input": {
    "from": "invoices",                           // optional hint, one word or a list
    "where": {
      "status": "paid",                           // shorthand for { "eq": "paid" }
      "issuedAt": { "gte": "2026-01-01", "lt": "2027-01-01" }
    },
    "groupBy": [{ "month": "month" }],            // output name → time bucket
    "orderBy": [{ "month": "asc" }],              // list: first entry sorts first
    "limit": 12
  },
  "output": [{ "month": "date", "revenue": "integer" }]
}
```

### 4.1 Fields

| Field | Required | Rules |
|---|---|---|
| `output` | **yes** (R2) | The response shape (§4.2). Keys are returned exactly as written. |
| `input` | no (missing means `{}`) | An object with only these keys, all optional: `from`, `where`, `groupBy`, `orderBy`, `limit`, `offset`. Any other key is an `INVALID_REQUEST` error that lists the allowed keys. |
| `input.from` | no | A word or a list of words naming what the data is about. A hint for the model, not a table name; list order doesn't matter. The model decides which tables to read and how to join them. |
| `input.where` | no | `{ name: condition }`, all combined with AND. A condition is a value (shorthand for `eq`) or `{ operator: value, … }`; several operators on one name are combined with AND. A name that is an aggregated `output` field filters groups (`HAVING`, R13). |
| `input.groupBy` | no | A list of `output` paths. An entry is a path (`"plan"`) or a time bucket `{ path: granularity }`, where granularity is `day`, `week`, `month`, `quarter` or `year`. Every `output` field in the same list that isn't grouped is an aggregate. Without `groupBy` the model decides, and `meta.mapping` shows its choice (R14). |
| `input.orderBy` | no | A list of `{ name: "asc" \| "desc" }`; a single object is allowed as shorthand. A name that is an `output` path (`"accounts.totalPaid"`) sorts the list that contains it (R15). |
| `input.limit`, `input.offset` | no | A non-negative integer, which applies to the top-level list, or `{ path: integer }` per list, for example `{ "items": 20 }` or `{ "$": 10, "accounts": 3 }` (`$` is the top-level list) (R15). The row cap still applies. |
| `intent` | not in v1 (R1) | Free text for meaning that neither the structure nor the glossary (R19) expresses. |

**Paths** name `output` fields by their keys joined with dots, skipping list
levels. In `[{ "plan": "string", "accounts": [{ "name": "string" }] }]`, the
paths are `plan`, `accounts` and `accounts.name`.

**Operators** (R17): `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in` (a list;
`[]` matches nothing), `notIn`, `contains` (text, case-insensitive),
`startsWith` (text, case-insensitive), `isNull` (`true` or `false`).

### 4.2 Output notation (R16)

* **Leaves:** `"string"`, `"number"`, `"integer"`, `"boolean"`, `"date"`
  (`YYYY-MM-DD`) or `"datetime"` (ISO 8601 with time zone), each optionally
  followed by `|null`. Every leaf is checked, including the date formats.
* **Lists:** `[X]` means a list of `X`.
* **Objects:** an object means exactly those keys.
* **Top level:**
  * a list means rows;
  * an object means one row: `data` is `null` when there is none, and more
    than one is a `SHAPE_MISMATCH`.
* **Every leaf sits under a name.** A bare `"string"` or `["string"]` at the
  top level is an `INVALID_REQUEST`, because nothing says what it holds;
  write `{ "countries": ["string"] }` or `[{ "country": "string" }]`.
* **Limits:** at most 6 levels deep and 50 fields.

### 4.3 Decisions

| # | Question | Decision | Status |
|---|---|---|---|
| R1 | What does a request contain? | `{ input, output }`. `intent` comes later as an optional field. When it comes, its normalized text becomes part of the request key, because it changes the meaning. | Decided |
| R2 | Is `output` required? | Yes. It's the main description of what's wanted, and it keeps the response shape fixed. | Decided |
| R3 | What goes in `input`? | Only the structure keys `from`, `where`, `groupBy`, `orderBy`, `limit` and `offset`. | Decided |
| R4 | Do names have to match the schema? | No. Every name in `input` and `output` is the caller's word. The model maps it to the closest table, column or expression. `output` keys come back exactly as written. | Decided |
| R5 | Several sources? | `from` takes a list. It is only a hint; joins are the model's job. | Decided |
| R6 | Are operators fuzzy too? | No. Operators, sort directions and time-bucket granularities are fixed lists, because they decide what the SQL does. An unknown one is an `INVALID_REQUEST` error that lists the valid ones. | Decided |
| R7 | How do value types count in matching? | Coarse types: `string`, `number` (whole and decimal together), `boolean`, `list`. | Decided |
| R8 | What does `null` mean in `where`? | Not given: the condition is dropped before matching, so optional dashboard filters can be sent as `null`. To ask for nulls, use `{ "isNull": true }`. | Decided |
| R9 | Does the caller see how names were mapped? | Yes. The model returns a mapping (name → column or expression, plus the grouping it chose), and `meta.mapping` shows it. If a name can't be mapped, the request fails with `FIELD_NOT_FOUND`, listing the closest names the model can see. The model maps a name only when the meaning matches, never to the nearest column just because it's close. Columns the database user can't read are never shown to the model, so they can't be mapped. | Decided |
| R10 | Are different spellings matched together? | No. `totalPaid` and `total_paid` are different requests, each mapped once. `output` keys can't be merged anyway, because they are returned as written. | Decided |
| R11 | Can Slime check the generated code against the request without a model? | Yes, after each run: every list respects its `limit`; rows follow `orderBy` when the sort name is in `output`; `eq` and `in` filters hold when the filtered name is in `output` and maps to the same column; a top-level object has at most one row. A failed check counts as a failed run, so the handler doesn't move up a tier. | Decided |
| R12 | `or` conditions? | Not in v1. | Decided |
| R13 | Filters on aggregates? | A `where` name that is an aggregated `output` field becomes `HAVING`: `where: { "accounts": { "gt": 10 } }` with `output: [{ "plan": "string", "accounts": "integer" }]` keeps plans with more than 10 accounts. | Decided |
| R14 | How is grouping expressed? | `groupBy` lists the `output` paths to group by. A time bucket's granularity is a **value**, bound as a parameter (`date_trunc($n, …)`), so one handler serves day, week and month. Without `groupBy` the model infers the grouping from the shape. | Decided |
| R15 | Sorting and limits inside nested lists? | `orderBy` names and `limit`/`offset` keys can be `output` paths, so "top 3 accounts in each plan" and "page of `items` plus `total`" can be written. | Decided |
| R16 | Output rules? | §4.2: `date` and `datetime` leaves, a top-level object is one row or `null`, every leaf is named. | Decided |
| R17 | Which operators? | The list in §4.1, including `notIn` and `startsWith`. | Decided |
| R18 | Are values checked? | Names are fuzzy, values are exact. The connector reads the allowed values of enum-like columns (Postgres enums and `CHECK … IN (…)`) into the schema. Before running, Slime checks `eq`, `ne`, `in` and `notIn` values on names mapped to such a column and fails with `INVALID_VALUE`, listing the allowed values. The model sees the allowed values (they are schema, not request data). On a cache miss the check runs right after generation, once the mapping is known. | Decided |
| R19 | Where does the meaning of a measure go? | In an app-wide `glossary` in `SlimeConfig`, for example `{ revenue: "sum of paid invoices, in cents", failedRate: "share from 0 to 1" }`. The model sees it with the schema, and its hash is part of the handler key, so changing a definition regenerates the handlers that depend on it. Per-request `intent` (R1) remains a later addition. | Decided |

### 4.4 Matching

* **Request key:** SHA-256 over the canonical structure without values:
  * `from` as a sorted list;
  * each `where` condition as name, operators and coarse value types, sorted
    by name;
  * `groupBy` entries in order, each marked as plain or time bucket (the
    granularity is a value);
  * `orderBy` names and directions, in order;
  * which lists have a `limit` or `offset`;
  * `output`;
  * `intent`, once it exists.
* **Parameters:** these values are bound into the SQL rather than written into
  the code:
  * `where` values;
  * `limit` and `offset` values;
  * time-bucket granularities.

  `{ "country": "DE", "limit": 5 }` and `{ "country": "FR", "limit": 50 }`
  share a handler.
* **Gas and Liquid:** reused only when all of these are the same:
  * the request key;
  * the schema hash;
  * the glossary hash;
  * the prompt hash;
  * the model.
* **Crystal:** reused when the request key, the schema hash and the glossary
  hash are the same.

### 4.5 What the model sees

* the schema: only what the database user can read, with comments and the
  allowed values of enum-like columns;
* the glossary;
* the request's structure: `from`, the `where` names with their operators and
  coarse types, `groupBy`, `orderBy`, which lists are limited, and `output`.

It never sees request values or rows.

### 4.6 What comes back

* **`data`** matches `output` exactly: no missing keys, no extra keys, right
  types and date formats. Otherwise the run fails with `SHAPE_MISMATCH`.
* **`meta`** has:
  * `tier` and `cache`;
  * `timingsMs`;
  * `sql`, `shapeJs` and `assumptions`;
  * `mapping` (R9);
  * `warnings`;
  * `review`.
* **Errors** are thrown as `SlimeError`: `{ code, message, retryable }` with an
  HTTP `status` (C9). New codes:
  * `FIELD_NOT_FOUND`: a name can't be mapped (R9);
  * `INVALID_VALUE`: a value isn't allowed for its column (R18).

### 4.7 How the protocol is published

The protocol is free in its names but strict in its structure, so it ships as
a type. All three forms come from one definition in `src/protocol/`:

1. **TypeScript types** (`SlimeRequest`, `Shape`) exported from
   `@slime-kit/core`. `slime.query()` infers the type of `data` from a
   literal `output`. For example, `output: [{ name: 'string' }] as const`
   gives `data: { name: string }[]`.
2. **JSON Schema** at `@slime-kit/core/request.schema.json`. It validates
   requests in any language, drives editor autocomplete, and works as an
   agent's tool input schema.
3. **`PROTOCOL.md`**: the rules plus the examples from
   `docs/protocol-cases.md`, written so a coding agent can build a
   frontend's requests without reading the source. It may also ship as
   `llms.txt`.

### 4.8 Changes from the sandbox

* The free-text `intent` and the free-form `input` are replaced by a
  structured `input` (R1, R3), with grouping (R14), nested sorting and limits
  (R15) and filters on aggregates (R13).
* Output notation: `date` and `datetime` leaves, one-row objects, named leaves
  (R16).
* The model returns a name mapping, shown in `meta.mapping` (R9).
* Checks without the model: after each run (R11), and on values against
  enum columns (R18).
* An app-wide glossary (R19).
* Whole and decimal numbers share a handler (R7).
* `null` filters are dropped (R8).

The generator and reviewer prompts change accordingly. The sandbox's parsing,
shape and matching tests are ported in M1, rewritten for this format.

## 5. Draft public API

This is the target for C4–C10, and it changes as we decide them.

```ts
import { createSlime, SlimeConfig } from '@slime-kit/core';
import { postgresConnector, postgresStore } from '@slime-kit/core/postgres';
import { claude } from '@slime-kit/core/claude';

// The app decides where values come from: env here, but any source works.
const config = new SlimeConfig({
  connector: postgresConnector({ url: process.env.READER_URL! }), // required; refuses to start if the user can write
  store: postgresStore({ url: process.env.WRITER_URL!, table: 'handlers' }), // default: in memory
  generator: claude.generator({ apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-haiku-5-5' }), // omit = locked mode
  reviewer: claude.reviewer({ apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-opus-5-5' }),    // omit = no review
  crystal: crystals,                // import { crystals } from './slime-crystal/index.js'; omit = off
  glossary: { revenue: 'sum of paid invoices, in cents' },        // optional; meaning of the app's words (R19)
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
  schema from `describe` gains the allowed values of enum-like columns (R18);
* `Generator` and `Reviewer`;
* `HandlerStore`: gains the table name as an option, which replaces PR #7's
  `SLIME_META_TABLE`;
* `SlimeError` and its error codes, plus `FIELD_NOT_FOUND` and
  `INVALID_VALUE` (§4.6).

## 6. Package layout (target)

```
oss/packages/core/
├── package.json        # @slime-kit/core, "exports" per subpath, peerDeps optional
├── tsconfig.json       # build → dist/, declarations on
├── src/
│   ├── index.ts        # createSlime, SlimeConfig, types, SlimeError
│   ├── config.ts       # SlimeConfig: defaults, validation, with()
│   ├── engine/         # engine, tiers, review loop, coalescing, rate limits
│   ├── protocol/       # request types, parsing, canonical key, JSON Schema (§4)
│   ├── checks/         # shape, sql guard, lint, result checks (R11), value checks (R18)
│   ├── sandbox/        # SandboxRunner Port + QuickJS worker (shape-worker.mjs)
│   ├── crystal/        # Crystal registry types; serving crystal handlers
│   ├── postgres/       # connector + store   → @slime-kit/core/postgres
│   ├── claude/         # generator + reviewer → @slime-kit/core/claude
│   ├── groq/           #                      → @slime-kit/core/groq
│   ├── offline/        #                      → @slime-kit/core/offline
│   └── crystallize/    # job, allowlist, check → @slime-kit/core/crystallize (+ bin)
└── test/
```

## 7. Milestones

Each milestone ends with green tests and a commit. The sandbox test that each
one ports is named, so parity can be checked.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Skeleton.** Root `package.json` with workspaces, core `package.json` with an exports map, `tsconfig`, `node:test`, a CI job "Core tests". | `npm test -w @slime-kit/core` runs; `npm pack` builds a tarball; CI is green. |
| M1 | **Protocol, contracts and pure parts.** Request types, parsing and the canonical request key (§4); output notation with `date`/`datetime` (R16); the JSON Schema generated from the types (§4.7); Ports, `SlimeError` with the new codes; SQL guard and lint; `SlimeConfig` with defaults, validation and `glossary`. | `units.test.ts` ported; every case in `docs/protocol-cases.md` parses (or is refused) as documented; the JSON Schema accepts and rejects the same requests as the parser. |
| M2 | **Engine, Gas path.** `createSlime`, `query`, memory store, offline generator, `SandboxRunner` with the QuickJS worker, coalescing, rate limits, locked mode, the result checks (R11), `meta.mapping`. | `engine.test.ts` and `sandbox.test.ts` ported; result checks reject a wrong sort, limit and filter; no `config` singleton anywhere. |
| M3 | **Postgres.** Connector with the start-up safety check and enum values in the schema; value checks (R18); store with a configurable table. | `postgres.test.ts` and `persistence.test.ts` ported; `status: "cancelled"` fails with `INVALID_VALUE` listing the allowed values. |
| M4 | **Models and Liquid.** Claude and Groq generators and reviewers with the new prompts (mapping, grouping, glossary, `FIELD_NOT_FOUND`); the review loop; promotion to Liquid. | Review and promotion tests pass; one live run against Groq or Claude on the protocol cases. |
| M5 | **Crystal.** Serving from an imported registry; the crystallize job writing TS or JS; the `check` command. | `crystal*.test.ts` ported; a hand-edited Crystal file fails `check`; TS and JS output both pass the equivalence test. |
| M6 | **Use it as a package.** An example app in `oss/examples/` that installs the packed tarball and calls `slime.query()` from an endpoint; `PROTOCOL.md` for people and agents; the bench rewritten in the new format and run on core. Then retire `sandbox/`. | The example answers a query from the tarball; the bench is at least as correct as the sandbox's. |

## 8. Risks

* **Two copies during the port.** Fixes that land in `sandbox/` before M6
  must be ported by hand. Keep the port short, and tell the team that new
  engine work goes into core.
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

C1–C11 are decided. Still to do: confirm C12 (what's out of scope), and agree
with the PR #7 author that core is built at `oss/packages/core` (§2). Then
start M0, the skeleton.
