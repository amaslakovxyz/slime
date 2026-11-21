# Multi-source handlers: concept and high-level plan

| | |
|---|---|
| Status | **Design** (draft for review; not on main) |
| Owner | Konstantin |
| Date | 2026-11-21 |
| Scope | `core/` (`@slime-cloud/core`), one new adapter subpath, one example app |
| Next step | Review this concept, then turn §9 into a step-by-step implementation plan |

## 0. Summary

Today one Slime instance reads from one Postgres database. A handler is one
`SELECT` plus an optional pure JavaScript `shape(rows, input)` function.

This document proposes **multi-source handlers**. One Slime instance gets
several named **sources**: a SQL source (the existing Postgres connector) and
any number of **API sources** (Notion first, then any REST API). A handler
becomes a list of **steps**, each one reading from one source, plus a `shape`
function that combines the step results into the requested output.

The rule that keeps this safe is unchanged from today: **the engine fetches,
the model plans, the sandbox combines.**

- Source adapters, written by people, hold the credentials and do all I/O in
  the app's process.
- The model writes only data: SQL text, the name of a declared API operation
  with its arguments bound to `input`, and a pure `shape` function.
- `shape` runs in the existing QuickJS sandbox and gets plain JSON. It has no
  network, files, environment or credentials.

The rest of the engine works unchanged:
- the request key and cache;
- the gas → liquid lifecycle;
- the review loop;
- output validation;
- locked mode.

Crystal for handlers that call APIs is deferred to a later phase.

The first build targets three sources:
- **Postgres**: the demo billing database from `examples/express`.
- **Notion**: a seeded workspace, as the first API source shipped in core.
- **Studio Ghibli films API**: public and keyless, wrapped by the example app.
  It proves that any REST API fits the same interface in a few dozen lines.

Estimated effort: **9–13 working days** for phases P0–P6 (§9).

## 1. Problem and goal

### 1.1 Use case

A team has a Postgres database and a SaaS tool or legacy REST API. Its
frontend needs one endpoint that answers with combined data. For example:

> "Enterprise accounts with their total paid revenue and the number of open
> negative feedback items about them."

Revenue lives in Postgres (`accounts`, `invoices`). Feedback lives in a Notion
database. Today the developer writes this backend by hand. With multi-source
handlers the frontend sends one Slime request, `{ intent, input, output }`, as
it does now. Slime generates a handler that reads both sources and combines
them. After enough successful runs the handler is promoted to liquid like any
other.

### 1.2 Goals

- G1. One Slime instance, several named sources: at most one SQL source and any
  number of API sources.
- G2. One handler can read from several sources and combine the results.
- G3. API sources are described to the model in the same dictionary format as
  database tables, rendered by Slime, not written by a model (D2).
- G4. Adding a new API is an adapter behind one interface, with no engine
  change. Proven with two very different APIs: Notion (authenticated,
  paginated, schema discovered at startup) and the Ghibli API (public,
  hand-declared schema).
- G5. The security properties of today hold: model-written code never touches
  credentials or does I/O, and sources are read-only.
- G6. Existing handlers (`.slime/handlers/*.json`) and the existing `connector`
  config keep working.

### 1.3 Non-goals (this iteration)

- Writes to any source.
- Model-written JavaScript that performs I/O ("path B" in the earlier analysis).
- Steps that depend on each other's results (for example, read keys from
  Postgres, then ask the API only for those keys). Planned for P7.
- Crystal for handlers with API steps. Planned for P7.
- More than one SQL source, and cross-database SQL.
- Non-HTTP sources (CSV, Excel, DuckDB). A separate track.
- Importing an OpenAPI spec automatically. Planned for P7.

## 2. Where we start

Key facts about core today (main @ 441c84b):

| Part | Today | File |
|---|---|---|
| Source | One `Connector`: `describe()`, `check(sql)`, `run(sql)`, `safetyCheck()`, `close()` | `core/src/connectors/types.ts` |
| Handler | `Artifact = { unsatisfiable, sql, params, shapeJs, assumptions }` | `core/src/models/types.ts` |
| Dictionary | Tables, columns, keys, enum values, glossary and rules, rendered as text; `schemaHash = sha256(schema)` | `core/src/dictionary/dictionary.ts` |
| Execution | `connector.run(sql)`, then `shape(rows, input)` in QuickJS, then output validation | `core/src/engine/execute.ts` |
| Generation | Generate, lint, `check` (cost), run; repairs on failure | `core/src/engine/generate.ts` |
| Sandbox | QuickJS (WASM) in worker threads; JSON in, JSON out; no `process`, `require` or `fetch` (tested) | `core/src/sandbox/quickjs/*`, `core/test/sandbox/quickjs.test.ts` |
| Lifecycle | Gas → liquid after `gasToLiquidRuns` successful runs, plus an approved review if a reviewer is set. Knows nothing about sources. | `core/src/engine/lifecycle.ts` |
| Crystal | `sql` + in-process `shape`, checked by allowlist, SQL lint and an equivalence test | `core/src/engine/crystal/*`, `core/src/crystallize/*` |

Decisions in `core/PLAN.md` this touches:

| Decision | Effect |
|---|---|
| C3 (ports) | Consistent: an API source is a new port beside `Connector`. |
| C7 (subpath adapters) | Consistent: Notion ships as `@slime-cloud/core/notion`. |
| C10 (Crystal) | Limited: API-step handlers are not crystallized in v1. |
| C12 (no connectors other than Postgres in v1) | **Amended** by this document. |
| D1 (metadata only) | Holds: Notion property schemas and select options are metadata. |
| D3 (rebuilt at start) | Holds, but startup now makes network calls. |
| R8 (explore in dev, locked in prod) and R11 (server sets identity values) | Unchanged, and more important: they now also cover third-party data. |

## 3. Concept

### 3.1 Who does what

```
            frontend: { intent, input, output }
                          │
                          ▼
┌──────────────────────── app process ────────────────────────┐
│  Slime engine                                               │
│   1. request key → cached handler, or model generates one   │
│   2. lint the handler's steps against the dictionary        │
│   3. run the steps in parallel, each through its source:    │
│                                                             │
│      ┌───────────────┐ ┌──────────────┐ ┌───────────────┐   │
│      │ db  (SQL)     │ │ notion (API) │ │ films (API)   │   │
│      │ pg pool,      │ │ token,       │ │ base URL,     │   │
│      │ read-only user│ │ rate limiter │ │ no auth       │   │
│      └──────┬────────┘ └──────┬───────┘ └──────┬────────┘   │
│             └── rows (plain JSON) per step ────┘            │
│                          │                                  │
│   4. ──────── JSON only ─┼──────────────────────────────    │
│      ┌───────────────────▼────────────────────────┐         │
│      │ QuickJS worker: shape(data, input)         │         │
│      │ no network, files, env or credentials      │         │
│      └───────────────────┬────────────────────────┘         │
│   5. validate the result against `output`, count the run    │
└───────────────────────────┼─────────────────────────────────┘
                            ▼
                     { data, meta }
```

Three roles, each kept narrow:

| Role | Written by | Holds credentials | Does I/O |
|---|---|---|---|
| Source adapter | people (core or app) | yes | yes, to one fixed service |
| Engine | core | holds references to adapters | only through adapters |
| Handler (steps and `shape`) | model | no | no; steps are data the engine executes |

### 3.2 Sources

A **source** is a named data provider in the config. Its name is the key the
model and the stored handlers use, for example `db` or `notion`.

```ts
// Sketch, not final.
new SlimeConfig({
  sources: {
    db: postgresConnector({ url }),                          // kind 'sql'
    notion: notionSource({ token, dataSources: { feedback: '<id>', movieNights: '<id>' } }),
    films: ghibliFilms,                                      // kind 'api', defined by the app
  },
  links: [
    { from: 'notion.feedback.account', to: 'db.accounts.name' },
    { from: 'notion.movieNights.film', to: 'films.films.title' },
  ],
  generator, reviewer, glossary, rules,
});
```

- `connector: x` stays valid and means `sources: { db: x }` (G6).
- **Two kinds of source.**
  - `sql`: today's `Connector`, unchanged apart from a `kind` tag.
  - `api`: a new port.
- **Proposed API source port.** It reuses `ColumnInfo`, `RunResult` and
  `SafetyReport` from `connectors/types.ts`:

```ts
interface ApiSource {
  readonly kind: 'api';
  readonly name: string;                       // adapter name, e.g. "notion"
  describe(): Promise<ApiSchema>;              // metadata only, never rows (D1)
  call(operation: string, args: Readonly<Record<string, unknown>>, options: CallOptions): Promise<RunResult>;
  safetyCheck(): Promise<SafetyReport>;        // e.g. the token works, every declared resource is readable
  close(): Promise<void>;
}

interface CallOptions { timeoutMs: number; rowCap: number; signal: AbortSignal }

interface ApiSchema {
  service: string;                             // shown to the model like `dialect`, e.g. "Notion API 2025-09-03"
  operations: OperationInfo[];
}

interface OperationInfo {
  name: string;                                // e.g. "feedback.query", "films.list"
  description?: string;
  params: ParamInfo[];                         // every param is nullable: null = "not given" (R5)
  columns: ColumnInfo[];                       // the flat row each call returns
  primaryKey?: string[];
  order?: string;                              // the order rows come back in, e.g. "created desc"
}

interface ParamInfo { name: string; type: LeafType; comment?: string; values?: string[] }
```

The **contract every API source keeps**:
- `call` returns flat rows whose values match the declared column types.
- Column types use the output notation leaves (`string`, `integer`, `number`,
  `boolean`, `date`, `datetime`, each optionally nullable). List columns are
  open question Q4.
- The adapter normalizes the service's JSON into these types, so `shape` and
  the model never see raw API payloads.

### 3.3 Handler format v2: steps

```jsonc
{
  "version": 2,
  "unsatisfiable": null,
  "steps": [
    { "name": "accounts", "source": "db",
      "sql": "SELECT a.name, sum(i.amount_cents)::int AS \"paidCents\" FROM accounts a JOIN plans p ON p.id = a.plan_id JOIN invoices i ON i.account_id = a.id AND i.status = 'paid' WHERE p.name = $1::text GROUP BY a.name",
      "params": ["plan"] },
    { "name": "feedback", "source": "notion", "operation": "feedback.query",
      "args": { "sentiment": { "value": "negative" }, "status": { "value": "Open" } } }
  ],
  "shapeJs": "function shape(data, input) { const open = new Map(); for (const f of data.feedback) open.set(f.account, (open.get(f.account) ?? 0) + 1); return data.accounts.map(a => ({ name: a.name, paidCents: a.paidCents, openNegative: open.get(a.name) ?? 0 })); }",
  "assumptions": ["Feedback is matched to accounts by exact account name."]
}
```

- **Step kinds:**
  - A SQL step: `{ name, source, sql, params }`, exactly today's `sql` and `params`.
  - An API step: `{ name, source, operation, args }`.
- **API step arguments.** Each argument is bound in one of two ways:
  - `{ "input": "<input name>" }`: the value comes from the request.
  - `{ "value": <constant> }`: a constant from the intent, for example
    "negative". A constant must match the parameter's type and its `values`
    list when there is one.
  - The model never builds URLs, paths, headers or query strings.
- **`shape` calling convention:**
  - v2: `shape(data, input)`, where `data` is `{ [stepName]: rows[] }`.
  - v1 handlers keep `shape(rows, input)`. The engine picks the convention by
    `version`, so a missing `version` means v1.
- **When `shapeJs` may be null.** It is required when there is more than one
  step. With one step it may be null, as today.
- **Storage.** Handlers stay in the same store, keyed by the same request key.
  A stored v2 handler holds names, SQL text, argument bindings and code. It
  never holds credentials or row data, so `.slime/` stays safe to commit.

### 3.4 Dictionary for API sources

Slime renders the dictionary for every source, in one format, with no model
(D2). Example for the demo:

```
Database db: postgresql 16
Table accounts
  id integer (primary key)
  name text
  ...

API source notion: Notion API 2025-09-03 (read-only, rate-limited)
Operation feedback.query: Customer feedback entries, newest first
  params (all optional; null = not given):
    sentiment string (one of: positive, neutral, negative)
    status string (one of: Open, Triaged, Done)
    created_from date
    created_to date
  returns rows:
    id string (primary key)
    title string
    account string (matches db.accounts.name)
    sentiment string (one of: positive, neutral, negative)
    status string (one of: Open, Triaged, Done)
    created datetime

API source films: Studio Ghibli API (public, read-only)
Operation films.list: Studio Ghibli feature films
  params: director string (exact director name)
  returns rows: id string (primary key), title string, director string, releaseYear integer, runningTimeMin integer, rtScore integer

Links between sources:
  notion.feedback.account → db.accounts.name
  notion.movieNights.film → films.films.title

Glossary: ...
Rules: ...
```

- **Discovered or declared.** The Notion adapter discovers its operations at
  startup from the data source schemas (§4.2). The Ghibli adapter declares
  them in code (§4.3). The dictionary does not care which.
- **Links.** These are cross-source join hints. They play the role foreign keys
  play inside a database, and Slime cannot discover them, so the app declares
  them in config. Without them the model has to guess which fields match.
- **Hashes.** `schemaHash` becomes a hash of every source's `describe()`
  output plus the links. A schema change in any source changes it:
  - in explore mode, handlers regenerate;
  - in locked mode, Slime warns.

  The source's data never enters the hash or the request key, so a new Notion
  row does not regenerate anything.

### 3.5 Generation, lint and execution

**Generation.** The flow does not change: generate, lint, check, run, repair.
- The generation prompt learns about steps, operations and `shape(data, input)`.
- The model still sees only the dictionary, the intent, input names and types,
  and the output shape. It never sees row data, including Notion page text.

**Lint.** Model-free and deterministic. It adds these checks to today's SQL lint:
- Step names are unique identifiers.
- Each step's source exists and is of the right kind.
- The operation exists, and its arguments name declared parameters.
- Every `input` binding names an input key.
- Constants match the parameter's type and `values`.
- No input value appears hard-coded in a constant. Today's hard-coded-value
  rule covers constants too.
- `shapeJs` is present when there is more than one step.
- There are at most `maxSteps` steps (new limit, proposed default 4).
- SQL steps also go through today's SQL lint.

**Check.** SQL steps go through `connector.check` (cost), as today. API steps
have no cost estimate. They count against a per-request call budget instead.

**Execution.**
1. All steps run in parallel under one deadline and one `AbortController`.
   If one step fails, the others are cancelled.
2. Each step's rows are checked against the operation's declared columns. A
   mismatch is an adapter bug, not a model error: it raises a new error,
   `SOURCE_CONTRACT`, and is not sent to the model for repair.
3. Source failures (timeout, 429, 5xx) raise a new error, `SOURCE_ERROR`:
   retryable, with a redacted message (§5). There is no partial data.
4. The combined `data` passes through the sandbox's existing memory limit,
   plus a new byte cap on all step rows together.
5. `shape` runs, then today's output validation and the R6 limit check.
6. `meta.truncated` is true if any step was truncated. In explore mode,
   `meta.steps` lists each step's source, row count, time and truncation.

### 3.6 Lifecycle, locked mode and Crystal

| Stage | Multi-source handlers |
|---|---|
| Gas | Unchanged: cached in memory after its first successful run. |
| Review | Unchanged loop. The review prompt shows the steps and the links. |
| Liquid | Unchanged rule (`lifecycle.ts`): enough successful runs, plus approval when a reviewer is set. |
| Locked | Serves saved v2 handlers like any other. Adapters still run, so sources must be reachable. |
| Crystal | v1: crystallize **skips** handlers with API steps and reports them. P7 adds a v2 module format and record-and-replay equivalence tests. |

### 3.7 What we deliberately do not do

- **No model-written code with I/O.** `shape` stays a pure function in QuickJS.
- **No model-chosen URLs, hosts, paths or headers.** Only declared operations
  with typed arguments.
- **No raw API payloads in prompts or in `shape`.** Adapters flatten them first.
- **No runtime schema guessing from data.** Schemas are declared, or read from
  the service's own schema endpoint (Notion).

## 4. Adapters

### 4.1 `defineApiSource`: the generic API source

Core ships a helper that turns a declaration into an `ApiSource`. The
declaration gives a fixed base URL, optional static headers, and operations,
each with a description, params, columns and a `run` function. A developer
wraps any REST API with it.

```js
// Sketch of an app-defined source (examples/multi-source/src/films.mjs).
import { defineApiSource } from '@slime-cloud/core';

export const ghibliFilms = defineApiSource({
  service: 'Studio Ghibli API (public, read-only)',
  baseUrl: 'https://ghibliapi.vercel.app',
  operations: {
    'films.list': {
      description: 'Studio Ghibli feature films',
      params: { director: { type: 'string', comment: 'exact director name' } },
      columns: { id: 'string', title: 'string', director: 'string', releaseYear: 'integer', runningTimeMin: 'integer', rtScore: 'integer' },
      primaryKey: ['id'],
      async run({ director }, { http }) {
        const films = await http.getJson('/films', { query: { director } });   // null/undefined params are dropped
        return films.map((f) => ({
          id: f.id, title: f.title, director: f.director,
          releaseYear: Number(f.release_date), runningTimeMin: Number(f.running_time), rtScore: Number(f.rt_score),
        }));
      },
    },
  },
});
```

`run` gets a constrained `http` client, not global `fetch`. The client is
where §5's transport rules are enforced once, for every adapter:
- It only reaches `baseUrl`.
- It encodes query values.
- It refuses redirects to other origins.
- It applies the deadline and `signal`, a response-size cap and JSON parsing.
- It turns failures into redacted `SourceError`s.

Whether to allow escaping to raw `fetch` is open question Q8.

The Ghibli API was chosen because:
- it needs no key;
- it filters on the server (`?director=`), which shows parameter pushdown;
- it returns numbers as strings, which tests the adapter's type normalization;
- its data is small and static.

It was checked on 2026-11-21. Alternatives if it disappears: SWAPI
(`swapi.info`) or TVMaze.

### 4.2 Notion: `@slime-cloud/core/notion`

The first API source shipped in core, as subpath `@slime-cloud/core/notion`
(C7). It calls Notion's HTTP API with `fetch` and the constrained client, with
no SDK dependency (like `groq/`).

**Configuration.**
```ts
notionSource({
  token,                                    // from the app; core never reads env (C4)
  notionVersion: '2025-09-03',              // pinned; newer versions exist (2026-03-11), confirm at build time
  dataSources: { feedback: '<data_source_id>', movieNights: '<data_source_id>' },
  exclude?: { feedback: ['Internal notes'] } // properties never exposed
})
```
The `dataSources` map is the allowlist and plays the role of a GRANT.
- Slime exposes only the data sources listed there.
- That holds even if the integration can see more pages.
- The alias (`feedback`) is the name the model sees.

**`describe()`.** It calls `GET /v1/data_sources/{id}` for each listed data
source and maps properties to columns:

| Notion property | Column type | Notes |
|---|---|---|
| title, rich_text | `string` | plain text, runs joined |
| number | `number` | |
| select, status | `string` with `values` = option names | like Postgres enum values (D1) |
| multi_select | list of strings, or a joined string | Q4 |
| date | `date` or `datetime` | start only; `end` becomes `<prop>_end` if needed |
| checkbox | `boolean` | |
| url, email, phone_number, unique_id | `string` | |
| created_time, last_edited_time | `datetime` | |
| relation | list of page ids | Q4 |
| people, files, formula, rollup | **excluded in v1** | `people` is personal data; formula and rollup need result-type handling |

Every row also gets `id` (the page id) as its primary key.

**Operations.** One per data source: `<alias>.query`. Parameters are generated
from the schema:
- equality on select, status and checkbox properties;
- `<prop>_from` / `<prop>_to` for date and created_time properties.

Null parameters add no filter. The adapter compiles the non-null parameters
into a Notion `filter` (an `and` of conditions). A model-written filter
language is the alternative (Q5).

**`call()`.** It sends `POST /v1/data_sources/{id}/query` and handles
Notion's limits:
- **Pagination:** follows `start_cursor` until the end or `rowCap`.
- **Rate limit:** a client-side limiter keeps under about 3 requests per second
  per source. A 429 is retried after `Retry-After` while the deadline allows.
- **Large results:** a page with `request_status` `incomplete` (Notion's
  10,000-result cap) sets `truncated`.

**`safetyCheck()`.**
- The token is valid.
- Every listed data source can be retrieved.
- Notion has no read-only tokens, so read-only holds in two layers:
  - The adapter's code only calls read endpoints, so it is read-only by
    construction.
  - The integration should have only the "Read content" capability in Notion.
    Setting that is a documented setup step. Whether it can be checked through
    the API is unknown and needs checking.

**Seed data.** `scripts/seed-notion.mjs` creates two data sources in a
workspace the integration can access. It needs a token with insert capability
and is used only for seeding. Slime's own token stays read-only.
- **Customer feedback:** about 40 entries. Fields: Title; Account (rich text,
  using real account names read from the demo database); Sentiment (select);
  Status (status); Area (multi-select); Created (date).
- **Movie nights:** about 15 entries. Fields: Film (title, matching Ghibli
  film titles); Host (select); Date (date); Rating (number).

### 4.3 Extending to other APIs

All of these use the same port and the same dictionary format. None is in this
iteration:

- **Hand-written** (`defineApiSource`): any REST API, such as a legacy
  internal API or Jira search. Jira is a natural second adapter in core: the
  search operation with typed parameters, flattened issues.
- **OpenAPI importer (P7):** generates `defineApiSource` operations from an
  OpenAPI document. It takes only GET operations, maps typed query parameters
  to params and flattens the response schema into columns. A person still
  picks which operations to expose.
- **Table-like SaaS** (Airtable, Google Sheets): the Notion pattern of a
  discovered schema with generated filter parameters.

## 5. Security model

### 5.1 Can model-written code get the secrets?

**In the gas and liquid path, no.** The owner's reasoning is right. Each
source runs separately with its own credentials, the data comes back, and
`shape` combines it in an isolated worker that only ever sees data. Credentials
exist only inside adapter objects in the app's main process. The worker gets a
JSON string. That boundary exists today (`quickjs-runner.ts` serializes rows
and input into the program text), and a test checks that `process`, `require`
and `fetch` are unreachable from `shape`.

| Code | Runs where | Can reach secrets | Written by |
|---|---|---|---|
| Source adapters | app process | yes, they hold them | people |
| SQL | Postgres, as the read-only user | only what the database user can reach | model |
| `shape` (gas, liquid) | QuickJS WASM in a worker; JSON in and out | **no** | model |
| `shape` (Crystal) | app process, no sandbox | in principle yes; only the static allowlist stops it | model, checked by the allowlist |

Model code cannot **read** secrets. They can still **leak indirectly**, through
the adapters and the plumbing around them. That is what the rules below are
for.

### 5.2 Threats and rules

| # | Threat | Rule | Test |
|---|---|---|---|
| S1 | **The model steers a request to another host** (SSRF). If an argument can shape the URL, the adapter sends its `Authorization` header to an attacker's server. | Base URL fixed per source. Arguments only as encoded query or body values; path segments validated against a pattern. Cross-origin redirects refused. No URL, host or path parameters. | Input values with `../`, `?`, `#` and full URLs reach the fake server encoded, on the same host. A redirect to another origin fails. |
| S2 | **Secrets in error text.** HTTP client errors often carry request headers or URLs. Error text reaches the HTTP response (`SlimeError` JSON), `onEvent` logs, and the repair prompt sent to the model provider. | Adapters throw `SourceError(status, safeMessage)` with no headers and no raw body. Each source declares its secret values and core redacts them from every message and event. | The token never appears in a `QueryResult`, `SlimeError.toJSON()`, an `onEvent` payload, a store file, or a prompt captured by a spy generator. |
| S3 | **Crystal runs `shape` in-process.** The allowlist is the only wall between model code and `process.env`. | v1: no Crystal for handlers with API steps. Keep the allowlist tests. | Crystallize skips API-step handlers and reports them. |
| S4 | **Non-JSON objects reach the sandbox** (adapter objects, functions, response objects with headers). | `ShapeJob` carries only `JSON.stringify`-able rows, checked against declared columns before they cross. | Contract test: rows are plain JSON. A row with a function or bigint is rejected. |
| S5 | **Secrets in the environment** widen the damage of any future bug that reads it. On Lambda, `platform/runtime/src/lambda.ts:30-42` loads every SSM parameter into `process.env`. | Pass each secret straight to its adapter. Separate change in `platform/runtime`: load only what the runtime needs. | Runtime review item, outside core tests. |
| S6 | **Too much data visible** (not a secret leak, but a data leak). | Least privilege per source acts as the GRANT. Postgres: read-only user, as today. Notion: "Read content" capability only, integration shared only with the listed data sources, and Slime exposes only `dataSources` minus `exclude`. `people` properties excluded by default. | Safety check fails if a listed data source is unreadable. Dictionary snapshot test shows no excluded properties. |
| S7 | **An open explore endpoint.** `POST /slime` in explore mode lets anyone generate queries over everything all sources can read, and spend Notion quota. | R8: explore only in development; locked in production. R11: identity-bound values come from the server. Document this in the example. | Example README states it. A locked-mode test shows no generation. |
| S8 | **Prompt injection through data.** Notion page text could contain instructions. | The model never sees rows: generation and review get the schema only. Repair errors never quote row values. | Spy generator: no seeded row text appears in any prompt. |
| S9 | **Resource abuse** (quota, memory, time). | Per-request call budget, per-source rate limiter, deadlines, per-step row cap, total byte cap, the QuickJS memory cap. | Budget and cap tests with a fake source. |
| S10 | **Writes.** | API adapters expose only read operations. Notion's adapter calls only `GET` and the query `POST`. The fake server in tests allows only those method and path pairs. | The fake server fails the test on any other method or path. |

## 6. Testing plan

All CI tests run without network access to third parties. Live tests are
opt-in.

| Layer | What | Runs in |
|---|---|---|
| T1 Unit | v2 handler parsing and lint (every rule in §3.5); dictionary rendering and `schemaHash` for API sources and links (deterministic, data-independent); the `shape(data, input)` convention; **v1 compatibility**: today's `.slime/handlers/*.json` from `examples/express` load and run unchanged; redaction; budget and deadline logic with fake sources. | CI |
| T2 Source contract | An `apiSourceContract(source, fixtures)` suite, like `core/src/testing/connector-contract.ts`. Run against a fake in-memory source, the Notion adapter over recorded fixtures, and the Ghibli adapter over recorded fixtures. Cases: `describe` is valid and stable; rows match declared types; null params add no filter; `rowCap` sets `truncated`; abort and timeout are honoured; 429 is retried within the deadline, then `SOURCE_ERROR`; no secret in any error; unknown operations or params are rejected; only allowed method and path pairs are called. | CI |
| T3 HTTP fixtures | A local fake server (`node:http`) replays recorded JSON. `npm run record:fixtures` records from the real APIs (needs a Notion token), scrubs tokens and ids, and the fixtures are committed. | CI (replay); manual (record) |
| T4 Engine integration | Postgres demo database (already a CI service) plus the fake Notion and Ghibli servers, with the offline generator holding v2 handlers. Cases: <br>• the combined query returns the expected output; <br>• repeated runs promote it to liquid, with and without a stub reviewer; <br>• locked mode serves a saved v2 handler; <br>• a Notion schema change changes `schemaHash` (explore regenerates, locked warns); <br>• one source down gives a retryable `SOURCE_ERROR` and no partial data; <br>• a step whose rows break the contract gives `SOURCE_CONTRACT`, not a repair. | CI |
| T5 Security | The tests in §5.2's last column, plus the existing sandbox isolation tests. | CI |
| T6 Live | `LIVE=1` with `NOTION_TOKEN` and `GROQ_API_KEY` (or `ANTHROPIC_API_KEY`). Seed Notion, run the three demo intents (§7) against real Notion, Ghibli and a real model. Check the output shape, non-empty results, and promotion after N runs. Add the intents as bench cases in `core/bench/`. | manual / nightly |
| T7 Example smoke | `examples/multi-source`: start it, `curl POST /slime` with the demo intents against the fake servers. | CI |

## 7. Demo scenario

Example app `examples/multi-source`, in the style of `examples/hono`: one Hono
file, `GET /health` and `POST /slime`. It configures:
- `db`: the demo database from `examples/express`;
- `notion`: the seeded workspace;
- `films`: the Ghibli source, defined in the example.

| # | Intent | Sources |
|---|---|---|
| 1 | Accounts on a given plan with their total paid revenue and their number of open negative feedback items, most open items first | `db` + `notion` |
| 2 | Movie nights with each film's director and running time, newest first | `notion` + `films` |
| 3 | Films by a given director with their Rotten Tomatoes score, highest first | `films` |

Intent 1 is the headline use case (§1.1). Intent 2 shows two API sources
combined. Intent 3 shows an API source alone, with server-side filtering.

## 8. How the code changes, by area

| Area | Change | Files (indicative) |
|---|---|---|
| Ports | `ApiSource`, `OperationInfo`, `ParamInfo`, `CallOptions`, `SourceError`; `kind` tag on `Connector` | `core/src/connectors/types.ts`, or a new `core/src/sources/` (Q9) |
| Config | `sources`, `links`, `maxSteps`, call budget, byte cap; `connector` as shorthand; validation of names and links | `core/src/config/*` |
| Dictionary | Render API sources and links; `schemaHash` over every source | `core/src/dictionary/dictionary.ts` |
| Handler | `Artifact` v2 with steps; v1 read path | `core/src/models/types.ts`, `core/src/engine/types.ts` |
| Lint | Step rules (§3.5) | `core/src/engine/checks/*` |
| Execution | Parallel steps, deadline, budget, row checks, redaction, `meta.steps`, `shape(data, input)` | `core/src/engine/execute.ts`, `generate.ts`, `slime-engine.ts`, `meta.ts`, `core/src/sandbox/quickjs/quickjs-runner.ts` |
| Models | Generation and review prompts for steps; JSON reply format and schema; offline generator accepts v2 | `core/src/models/prompts.ts`, `roles.ts`, `offline/` |
| Crystal | Skip API-step handlers, with an event | `core/src/crystallize/crystallize.ts` |
| Adapters | `defineApiSource` and the constrained HTTP client; `notion/` subpath | `core/src/sources/api/*`, `core/src/sources/notion/*`, `core/package.json` exports |
| Testing | `apiSourceContract`, fake HTTP server, fixtures | `core/src/testing/*`, `core/test/**` |
| Example | `examples/multi-source` with the Ghibli source and seed script | new |
| Docs | This document; `core/PLAN.md` (C12, new decisions); `core/docs/request-format.md` (`meta.steps`, new error codes); READMEs | |

Changing the prompts changes `promptHash`, so existing handlers regenerate in
explore mode the next time they are requested. Locked mode is not affected.

## 9. High-level plan

| Phase | Goal | Exit criteria | Effort |
|---|---|---|---|
| **P0** Decide | Review this document; settle §10; amend `core/PLAN.md` C12 and add the new decisions | Open questions answered; PLAN updated | 0.5 d |
| **P1** Sources and dictionary | `sources` config with `connector` shorthand; `ApiSource` port; dictionary renders API sources and links; `schemaHash` over all sources | T1 dictionary tests pass; all existing tests pass unchanged | 1–1.5 d |
| **P2** Handler v2 and execution | Steps, lint, parallel execution, budgets, row checks, `SOURCE_ERROR` and `SOURCE_CONTRACT`, redaction, `shape(data, input)`, `meta.steps`; v1 compatibility | T1 and T4 pass with a fake API source; v1 handlers still run | 2–3 d |
| **P3** Models | Prompts, reply schemas and the offline generator for v2 | Offline v2 generation works; one live generation of a two-source handler | 1–1.5 d |
| **P4** Generic API source | `defineApiSource`, constrained HTTP client, `apiSourceContract`, fake server; the Ghibli source in the example, with fixtures | T2 passes for the fake source and Ghibli; S1, S2, S10 tests pass | 1–1.5 d |
| **P5** Notion | `@slime-cloud/core/notion`: describe mapping, filter compilation, pagination, rate limit, safety check; seed script; recorded fixtures | T2 passes for Notion; T3 recording works against a real workspace | 2–3 d |
| **P6** Example, tests, docs | `examples/multi-source`; T4, T5 and T7 in CI; T6 live run; docs | The three demo intents answer live and promote to liquid; CI green | 1.5–2 d |
| **Total** | | | **9–13 d** |

**Order.** P1 → P2 → P3 is the critical path. P4 can start once P1's types
exist. P5 needs P1 and the contract suite from P4. P6 comes last.

**Later (P7, not planned yet):**
- dependent steps (arguments bound to earlier steps' columns, with batching);
- Crystal for API-step handlers (v2 module format, record-and-replay equivalence);
- the OpenAPI importer;
- a Jira adapter;
- per-source schema hashes, so one source's change doesn't regenerate every handler;
- optional TTL caching inside adapters.

**Timing against the demo.** The earlier revenue review recommended freezing
`core/` until the hackathon demo. This work should live on a branch until that
call is made (Q10).

## 10. Open questions

Each question has a recommendation, so a reviewer can accept or argue.

| # | Question | Recommendation |
|---|---|---|
| Q1 | Uniform `steps` for every handler, or keep top-level `sql` and add `calls`? | Uniform `steps` with a v1 read path. One shape for lint, review, meta and later Crystal. |
| Q2 | More than one SQL source? | Not in v1. One SQL source keeps one dialect in prompts and lint. |
| Q3 | Constants in API arguments? | Yes, typed and checked against `values`. Otherwise intents like "open negative feedback" need extra inputs. |
| Q4 | List-valued columns (multi_select, relation)? | Allow lists of strings in source rows: `shape` handles them, and output validation applies only to the final output. Alternative: joined strings. |
| Q5 | Notion filters: generated equality and range params, or a model-written filter language? | Generated params in v1. Small, typed, lintable. Anything finer is done in `shape`, and small demo data makes that fine. |
| Q6 | A source is down at startup? | Fail fast, matching today's behaviour when the database is unreachable. Degraded mode later if needed. |
| Q7 | Crystal for API-step handlers? | Not in v1 (S3, and equivalence on live data is not deterministic). |
| Q8 | Can a `defineApiSource` operation use raw `fetch`? | No. Only the constrained client, so S1 and S2 are enforced in one place. App-specific needs extend the client. |
| Q9 | Naming and folders: "source" vs "connector"; `connectors/` vs `sources/`? | "Source" is the umbrella term, and the Postgres connector is a SQL source. New code goes in `core/src/sources/`; `connectors/` stays until a rename is worth it. |
| Q10 | Merge before or after the demo? | Build on a branch. Merge after the demo unless the demo needs it, because the prompt change regenerates handlers prepared for the demo. |
| Q11 | Expose Notion `people` properties? | Excluded by default; opt in per property later. |

## 11. Glossary

- **Source:** a named data provider in the config, either SQL or API.
- **Operation:** a named, typed read an API source offers. Its arguments go in
  and flat rows come out.
- **Step:** one read in a handler: a SQL query or an operation call.
- **Link:** a declared cross-source join hint, like a foreign key between
  sources.
- **Adapter:** the code that implements a source, written by people. It holds
  the credentials.
