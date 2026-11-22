# Multi-source handlers: concept and high-level plan

| | |
|---|---|
| Status | **Built, merged to `main`** (PR #26) as an experimental core layer: P0–P6 done, including real Notion fixtures (P5.5); the live Notion run (P6.5) is pending. `platform/runtime` and the admin don't configure API sources yet. |
| Owner | Konstantin |
| Date | 2026-11-21 (revised after the review in PR #26) |
| Scope | `core/` (`@slime-cloud/core`), one new adapter subpath, one example app |
| Next step | Confirm handler shape against [product frame v0.2](../../docs/product/product_frame_v0_2.md) (open questions); run P6.5; wire sources into `platform/runtime` |


> **Update 2026-11-22:** the v1/v2 split described here is gone. Every handler now uses the
> steps format, with one set of prompts; the single-query form is only read from old records
> (PLAN.md MS3). Text below that keeps setups without API sources "byte-identical" is history.

## 0. Summary

Slime is a backend library. A frontend sends `{ intent, input, output }`; a
model writes a read-only handler for that request once, and Slime caches,
reviews and serves it. Decisions cited as C\*, D\* or R\* are in
[core/PLAN.md](../PLAN.md).

Today one Slime instance reads from one Postgres database. A handler is one
`SELECT` plus an optional pure JavaScript `shape(rows, input)` function.

This document proposes **multi-source handlers**. One Slime instance gets
several named **sources**: a SQL source (the existing Postgres connector) and
any number of **API sources** (Notion first, then any REST API). A handler
becomes a list of **steps**, each one reading from one source, plus a `shape`
function that combines the step results into the requested output.

The rule that keeps this safe is the one core already follows: **the engine
fetches, the model plans, the sandbox combines.**

- Source adapters, written by people, hold the credentials and do all I/O in
  the app's process.
- The model writes only data: SQL text, the name of a declared API operation
  with its arguments bound to `input`, and a pure `shape` function.
- `shape` runs in the existing QuickJS sandbox and gets plain JSON. It has no
  network, files, environment or credentials.

These parts keep their current behaviour; the code that runs them changes in
`execute`, `generate` and `meta` (§9):
- the request key and cache;
- the gas → liquid lifecycle;
- the review loop;
- output validation;
- locked mode.

With no API source configured, Slime behaves exactly as today (§3.3,
compatibility rule). Crystal for handlers that call APIs came later: steps
modules (§3.6).

The first build targets three sources:
- **Postgres**: the demo billing database from `examples/express`.
- **Notion**: a seeded workspace, as the first API source shipped in core. Its
  dictionary is built from Notion's own schema at startup, as the database's
  is built from the catalog.
- **Studio Ghibli films API**: public and keyless, wrapped by the example app.
  It shows that a second, very different API fits the same interface with
  about 30 lines of app code.

Estimated effort: **about 20 person-days (18–22)** for one developer, phases
P0–P6 (§10), after the architect and staff-engineer reviews of the
implementation plan.

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

- G1. One Slime instance, several named sources: exactly one SQL source and any
  number of API sources. (A setup with no SQL source would make
  `config.connector` optional and ripple through the engine and
  `platform/runtime`; none of the use cases needs it.)
- G2. One handler can read from several sources and combine the results.
- G3. API sources are described to the model in the same dictionary format as
  database tables, rendered by Slime from metadata, not written by a model
  (D2: the dictionary is rendered by code).
- G4. Adding a new API is an adapter behind one interface, with no engine
  change. Checked against two very different APIs: Notion (authenticated,
  paginated, schema discovered at startup) and the Ghibli API (public,
  hand-declared schema). The owner asked for both, so that two unlike APIs go
  through one interface.
- G5. The security properties of today hold: model-written code never touches
  credentials or does I/O, and sources are read-only.
- G6. Existing handlers (`.slime/handlers/*.json`), the existing `connector`
  config and existing custom connectors keep working.

### 1.3 Non-goals (this iteration)

- Writes to any source.
- Model-written JavaScript that performs I/O (path B, §3.7).
- Steps that depend on each other's results (for example, read keys from
  Postgres, then ask the API only for those keys). Listed under P7 (later).
- More than one SQL source, and cross-database SQL.
- Non-HTTP sources (CSV, Excel, DuckDB). A separate track.
- Importing an OpenAPI spec automatically. Listed under P7.

## 2. Where we start

Key facts about core today (main @ 441c84b):

| Part | Today | File |
|---|---|---|
| Source | One `Connector`: `describe()`, `check(sql)`, `run(sql)`, `safetyCheck()`, `close()` | `core/src/sources/sql/types.ts` |
| Handler | `Artifact = { unsatisfiable, sql, params, shapeJs, assumptions }` | `core/src/models/types.ts` |
| Dictionary | Tables, columns, keys, enum values, comments, glossary and rules, rendered as text; `schemaHash = sha256(schema)` | `core/src/dictionary/dictionary.ts` |
| Execution | `connector.run(sql)`, then `shape(rows, input)` in QuickJS, then output validation | `core/src/engine/execution/execute.ts` |
| Generation | Generate, lint, `check` (cost), run; on failure the error text goes back to the model for repair | `core/src/engine/generation/generate.ts` |
| Sandbox | QuickJS (WASM) in worker threads; JSON in, JSON out; no `process`, `require` or `fetch` (tested) | `core/src/sandbox/quickjs/*`, `core/test/sandbox/quickjs.test.ts` |
| Lifecycle | Gas → liquid after `gasToLiquidRuns` successful runs, plus an approved review if a reviewer is set. Knows nothing about sources. | `core/src/engine/promotion.ts` |
| Crystal | A liquid handler rewritten into a JS module committed to the app: `sql` + in-process `shape`. Checked by an allowlist, SQL lint and an equivalence test that replays recorded inputs and compares results with the original. | `core/src/engine/crystal/*`, `crystal/src/*` |

**How handlers are found and refreshed.** The request key hashes only the
normalized intent, the input names and the output shape. Each stored handler
records `schemaHash`, `dictionaryHash` and `promptHash`. Explore mode
regenerates a handler whose recorded hashes differ from the current ones;
locked mode serves it anyway and warns once at startup.

Decisions this touches:

| Decision | Effect |
|---|---|
| C3 (ports) | Consistent: an API source is a new port beside `Connector`. |
| C4 (core never reads env) | Holds: the app passes tokens to adapters. |
| C7 (subpath adapters) | Consistent: Notion ships as `@slime-cloud/core/notion`. |
| C10 (Crystal) | Handlers with API steps (or several SQL steps) become steps modules (§3.6). |
| C12 (no connectors other than Postgres in v1) | **Amended** by this document. |
| `docs/product/concepts_brief.md` non-goal "Connectors other than Postgres" | **Amended** together with C12. |
| D1 (metadata only) | Holds: Notion property schemas and select options are metadata. |
| D3 (dictionary rebuilt at start) | Holds, but startup now makes network calls. |
| R5 (null input means "not given") | Applies to API parameters too. |
| R6 (the result has at most `input.limit` rows) | Unchanged; checked after `shape`. |
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
│      │ read-only user│ │ fixed URL    │ │ no auth       │   │
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

A **source** is a named data provider. In config, `sources` is the map of them;
each key is the name the model and the stored handlers use, for example `db`
or `notion`.

```ts
// Sketch, not final.
new SlimeConfig({
  sources: {
    db: postgresConnector({ url }),                          // kind 'sql'
    notion: notionSource({ token, dataSources: { feedback: '<id>', movieNights: '<id>' } }),
    films: ghibliFilms,                                      // kind 'api', defined by the app
  },
  generator, reviewer, glossary, rules,
});
```

- `connector: x` stays valid and means `sources: { db: x }` (G6).
- **Two kinds of source.**
  - `sql`: today's `Connector`, with `kind: 'sql'`. (It was optional at first,
    for custom connectors; required since the package has no outside users.)
  - `api`: a new port.
- **Proposed API source port.** It reuses `ColumnInfo`, `RunResult` and
  `SafetyReport` from `connectors/types.ts`:

```ts
interface ApiSource {
  readonly kind: 'api';
  readonly name: string;                       // adapter name, e.g. "notion"
  readonly secrets: readonly string[];         // values core redacts from every message and event (S2)
  describe(options: SourceCallOptions): Promise<ApiSchema>;   // metadata only, never rows (D1)
  call(operation: string, args: Readonly<Record<string, unknown>>, options: CallOptions): Promise<RunResult>;
  safetyCheck(options: SourceCallOptions): Promise<SafetyReport>;  // the token works
  close(): Promise<void>;
}

interface SourceCallOptions { timeoutMs: number; signal: AbortSignal }
interface CallOptions extends SourceCallOptions { rowCap: number }

interface ApiSchema {
  service: string;                             // shown to the model like `dialect`, e.g. "Notion API 2025-09-03"
  operations: OperationInfo[];
}

interface OperationInfo {
  name: string;                                // e.g. "feedback.query", "films.list"
  description?: string;
  params: ParamInfo[];                         // every param is nullable (R5)
  columns: ColumnInfo[];                       // the flat row each call returns
  primaryKey?: string[];
  order?: string;                              // the order rows come back in, e.g. "created desc"
}

interface ParamInfo { name: string; type: LeafType; comment?: string; values?: string[] }
```

For API sources, `SafetyReport.user` is the integration or account name the
token belongs to.

The **contract every API source keeps**:
- `call` returns flat rows of plain JSON values that match the declared column
  types.
- Column types are output-notation leaves (`string`, `integer`, `number`,
  `boolean`, `date`, `datetime`), nullable where declared. There are no list
  columns in v1.
- The adapter normalizes the service's JSON into these types, so `shape` and
  the model never see raw API payloads.
- **Join hints are column comments.** A column that matches a column in another
  source says so in its `comment`, for example `matches db.accounts.name`. The
  dictionary already renders comments; there is no separate links config.

### 3.3 Handler format v2: steps

**Compatibility rule.** With no API source configured, Slime is byte-identical
to today: the same prompts and `promptHash`, v1 artifacts
(`{ sql, params, shapeJs }`), the same dictionary text and `schemaHash`, and
the same Crystal path. v2 artifacts are produced only when at least one API
source is configured.

```jsonc
{
  "version": 2,
  "unsatisfiable": null,
  "steps": [
    { "name": "accounts", "source": "db",
      "sql": "SELECT a.name, sum(i.amount_cents)::int AS \"paidCents\" FROM accounts a JOIN plans p ON p.id = a.plan_id JOIN invoices i ON i.account_id = a.id AND i.status = 'paid' WHERE p.name = $1::text GROUP BY a.name",
      "params": ["plan"] },
    { "name": "feedback", "source": "notion", "operation": "feedback.query",
      "args": [ { "param": "sentiment", "input": null, "value": "negative" },
                { "param": "status", "input": null, "value": "Open" } ] }
  ],
  "shapeJs": "function shape(data, input) { const open = new Map(); for (const f of data.feedback) open.set(f.account, (open.get(f.account) ?? 0) + 1); return data.accounts.map(a => ({ name: a.name, paidCents: a.paidCents, openNegative: open.get(a.name) ?? 0 })); }",
  "assumptions": ["Feedback is matched to accounts by exact account name."]
}
```

- **Step kinds:**
  - A SQL step: `{ name, source, sql, params }`, exactly today's `sql` and `params`.
  - An API step: `{ name, source, operation, args }`.
- **API step arguments.** `args` is a list, one entry per bound parameter:
  `{ "param", "input", "value" }` with exactly one of `input` and `value` set.
  - `input`: the value comes from the request input of that name.
  - `value`: a constant from the intent, for example "negative". A constant
    must match the parameter's type and its `values` list when there is one.
  - A list, not a map keyed by parameter name, because model structured output
    (Claude) accepts only closed JSON objects.
  - The model never builds URLs, paths, headers or query strings.
- **Format marker.** `"version": 2` identifies a v2 artifact. A stored artifact
  without it is v1 and keeps `shape(rows, input)`; v2 gets
  `shape(data, input)`, where `data` is `{ [stepName]: rows[] }`.
- **When `shapeJs` may be null.** It is required when there is more than one
  step. With one step it may be null, as today.
- **Single-SQL-step artifacts become v1 before they run.** When the model
  returns a v2 artifact whose only step is SQL, the engine converts it to v1
  before the first run, so the stored code is the code that ran. The model's
  function is nested, not renamed:
  `function shape(rows, input) { <model's function shape(data, input) …> return shape({ <step>: rows }, input); }`.
  The inner declaration shadows the outer one, which the Crystal allowlist
  accepts. Everything after that (execution, meta, review, Crystal) sees a v1
  handler. Every stored v2 artifact therefore has at least one API step, and
  those are skipped by Crystal in v1 (§3.6).
- **Saved handlers are checked against today's sources.** Each time a v2
  handler is loaded, and once at startup in locked mode, the step lint (§3.5)
  runs against the current sources and schemas. A handler that fails it (a
  removed source, a renamed Notion property or option) is not served: explore
  mode regenerates it, locked mode answers `HANDLER_NOT_FOUND` with the reason,
  and startup lists such handlers in one warning.
- **Storage.** Handlers stay in the same store, keyed by the same request key.
  A stored v2 handler holds names, SQL text, argument bindings and code. It
  never holds credentials or row data, so `.slime/` stays safe to commit.
- **Rollback.** A core without this change cannot read v2 handlers. When
  downgrading, clear `.slime/` or keep only v1 handlers.

### 3.4 Dictionary for API sources

Slime renders the dictionary for every source in one format, with no model
(D2). API operations use the same column format as tables today
(`name type null|not null [primary key] [one of: …] [-- comment]`). With API
sources configured, the database heading names the SQL source in quotes
(`Database source "db": postgresql 16` instead of today's
`Database: postgresql 16`). In the P0 spike, without the name the model used
`postgresql` as the step's source; in the P3.4 live run, with the name but
unquoted, it took the whole heading (including Postgres' long version string)
as the name. API headings quote the name the same way. With no API source the
heading stays as today. Example for the demo:

```
Database source "db": postgresql 16
Table accounts
  id integer not null primary key
  name text not null
  ...

API source "notion": Notion API 2025-09-03 (read-only access)
Operation feedback.query: Customer feedback entries, newest first
  params (all optional; null = not given):
    sentiment string one of: positive, neutral, negative
    status string one of: Open, Triaged, Done
    created_from date
    created_to date
  returns rows:
    id string not null primary key
    title string null
    account string null -- matches db.accounts.name
    sentiment string null one of: positive, neutral, negative
    status string null one of: Open, Triaged, Done
    created datetime null
Operation movieNights.query: Movie nights, newest first
  ...

API source "films": Studio Ghibli API (public, read-only)
Operation films.list: Studio Ghibli feature films
  params (all optional; null = not given):
    director string -- exact director name
  returns rows:
    id string not null primary key
    title string not null
    director string not null
    releaseYear integer not null
    runningTimeMin integer not null
    rtScore integer not null

Glossary: ...
Rules: ...
```

- **Discovered or declared.** The Notion adapter discovers its operations at
  startup from Notion's data source schemas (§4.2), the way the Postgres
  connector reads the catalog. The Ghibli adapter declares them in code
  (§4.1). The dictionary does not care which.
- **Hashes.** `schemaHash` becomes a hash of every source's `describe()`
  output. A schema change in any source changes it, so explore mode
  regenerates handlers and locked mode warns (§2). The source's data never
  enters the hash or the request key, so a new Notion row regenerates nothing.
  Provenance also records one hash per source (`sourceHashes`, an additive
  field). Crystal's schema warning compares only the SQL source's hash, so
  adding an API source or editing a Notion option doesn't flag every Crystal
  handler.

### 3.5 Generation, lint and execution

**Generation.** The flow does not change: generate, lint, check, run, repair.
- The generation prompt learns about steps, operations and `shape(data, input)`.
- The model sees the dictionary, the intent, input names and types, and the
  output shape. Rows are never put in the prompt.
- Repair errors differ by format. For v1 (no API source configured) a failed
  attempt's error text goes back to the model as it does today, and can
  contain values (`request/shape.ts`, `quickjs-runner.ts`, `generate.ts`). For
  v2, the repair message carries only the error code, the failing paths and the
  expected and actual types, never values. Text written in Notion by outside
  customers therefore cannot reach the model through repair. Source errors are
  redacted (S2) and final, so they never reach the repair prompt either.

**Lint.** Model-free and deterministic. It adds these checks to today's SQL lint:
- Step names are unique identifiers.
- Each step's source exists and is of the right kind.
- The operation exists, and its arguments name declared parameters.
- Every `input` binding names an input key.
- Each `args` entry sets exactly one of `input` and `value`.
- Constants match the parameter's type and `values`.
- No input value appears hard-coded in a constant. Today's hard-coded-value
  rule covers constants too.
- `shapeJs` is present when there is more than one step.
- There are at most `maxSteps` steps (new limit, default 4).
- SQL steps also go through today's SQL lint.

The same lint runs when a saved v2 handler is loaded (§3.3).

**Check.** SQL steps go through `connector.check` (cost), as today. API steps
have no cost estimate. Each SQL step is bounded by `rowCap` and
`statementTimeoutMs`, as today. Each API step is bounded by `rowCap` and a new
`apiTimeoutMs` (default 10 s); 2 s would not fit Notion pagination and one
`Retry-After` wait. The combined data is bounded by `shapeMemoryBytes` in the
sandbox.

**Execution.**
1. Every run checks each input value bound to an API parameter against the
   parameter's type, not only the first run; a mismatch, or a list bound to a
   scalar, is `INVALID_REQUEST`.
2. All steps start in parallel under one deadline (the larger of the two
   timeouts). Any failing step aborts the API steps through a shared
   `AbortSignal`; a running SQL step is not cancelled (`Connector.run` takes no
   signal) and its result is discarded. When several steps fail, the first
   failure that is not an abort is reported.
3. API rows must be plain JSON; a bigint, function, symbol or undefined is a
   source contract failure. SQL rows keep today's handling (`Date` objects from
   pg become ISO strings in `JSON.stringify`).
4. Errors are classified once, at the source boundary:
   - a SQL failure stays `QUERY_ERROR`, repairable, as today;
   - an API 429, 5xx or timeout becomes `SOURCE_ERROR` (502, `retryable: true`);
   - any other API 4xx becomes `SOURCE_ERROR` with `retryable: false`;
   - `SOURCE_ERROR` is final during generation (added to `FINAL_CODES`),
     because the model can't fix an outage; its details carry the source, the
     operation, the HTTP status and the attempt count, never secrets.
   There is no partial data.
5. If any step is truncated and the handler has more than one step, the run
   fails with `QUERY_TOO_LARGE` (HTTP 422, not retryable). During generation
   it is repairable: the model can add a filter. `rowCap` is therefore the
   largest data set one step may read in v1. A single-step handler keeps
   today's behaviour: rows are cut and `meta.truncated` is true.
6. `shape` runs, then today's output validation and the R6 limit check.
7. `timingsMs.run` is the wall time of all steps. In explore mode, `meta.steps`
   lists each step's name, source, operation and arguments (API steps), SQL
   (SQL steps), row count and time.

**Rules the design keeps.**
- No model-chosen URLs, hosts, paths or headers: only declared operations with
  typed arguments.
- No raw API payloads in prompts or in `shape`: adapters flatten them first.
- No schema guessed from data: schemas are declared in code, or read from the
  service's own schema endpoint (Notion).

### 3.6 Lifecycle, locked mode and Crystal

| Stage | Multi-source handlers |
|---|---|
| Gas | Unchanged: cached in memory after its first successful run. |
| Review | Unchanged loop. The review prompt shows the steps. |
| Liquid | Unchanged rule (`lifecycle.ts`): enough successful runs, plus approval when a reviewer is set. |
| Locked | Serves saved v2 handlers that pass the step lint against today's sources (§3.3). Adapters still run, so sources must be reachable. |
| Crystal | A single-SQL-step handler becomes a query module, as before. Any other handler becomes a steps module (2026-11-22, replacing MS9): `export const steps` (a plain literal of its Liquid steps) and `export function shape(data, input)`, checked by the same allowlist. The equivalence test calls the live sources on the app's instance (`Crystallizer`); a source that changes between the Liquid and the Crystal run makes it fail, never pass wrongly. `slime-crystal verify` without the app's sources accepts such a module only while it is exactly its Liquid code. |

### 3.7 Alternatives considered

| Option | What it is | Why not, for this iteration |
|---|---|---|
| A0: import snapshots into Postgres | The app copies Notion or API data into Postgres tables on a schedule; core is unchanged | No live data, and every new source needs its own import job. Still the right answer when freshness doesn't matter. |
| Path B: model-written JavaScript with I/O | `shape` becomes async and calls APIs through host functions | Model code would hold network access, and Crystal would run it in-process with no sandbox. It needs a new sandbox and new review and Crystal rules: about 4–6 weeks. |
| DuckDB as a federation layer | Every source becomes a DuckDB table; the model writes one SQL query | It fits files, not authenticated, paginated APIs. DuckDB can read local files and URLs unless locked down, which would expose the process environment. |
| **Chosen: declared operations + pure `shape`** | The engine calls declared, typed operations; the model only binds arguments and combines rows | Keeps today's trust boundary; Crystal can follow later. |

## 4. Adapters

### 4.1 `defineApiSource`: the generic API source

Core ships a helper that turns a declaration into an `ApiSource`. The
declaration gives a fixed base URL, optional static headers, and operations,
each with a description, params, columns and a `run` function. A developer
wraps a REST API with it.

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
- It only reaches `baseUrl`. A path must start with one `/`, must not contain
  `//` or `..`, and is appended to `baseUrl` (keeping any path prefix); after
  building the URL the client checks that its origin equals `baseUrl`'s.
- It encodes query values.
- It follows at most 3 same-origin redirects and refuses any redirect to
  another origin.
- It applies one deadline (`apiTimeoutMs`) and the `signal` to all attempts,
  caps the response at 10 MB while reading the stream, and parses JSON.
- It retries a 429 after `Retry-After` while the deadline allows.
- It turns failures into `SourceError`s whose messages are redacted. Every
  header value it sends is added to the source's secrets automatically.

The retry helper is new and small (`core/src/sources/api/http/retry.ts`), with one
deadline for all attempts. The Groq client keeps its own retry logic: it
reports provider wait time and classifies retries from the response body,
which a shared helper would change. An adapter that needs more (custom auth, a
POST body) gets options on the client: headers, method and body. There is no
raw `fetch` (Q8).

The Ghibli API was chosen because:
- it needs no key;
- it filters on the server (`?director=`), which shows parameter pushdown;
- it returns numbers as strings, which tests the adapter's type normalization;
- its data is small and static.

It was checked on 2026-11-21. Alternatives if it disappears: SWAPI
(`swapi.info`) or TVMaze.

### 4.2 Notion: `@slime-cloud/core/notion`

The first API source shipped in core, as subpath `@slime-cloud/core/notion`
(C7). It calls Notion's HTTP API only through the constrained client (§4.1),
with no SDK dependency (like `groq/`).

**Notion terms.** Since API version 2025-09-03, a Notion *database* is a
container and a *data source* is a table inside it; queries go to data
sources. An *integration* is the bot identity that owns the token; it sees only
pages shared with it, and its *capabilities* (read content, update content,
insert content) are set in Notion's UI. See Notion's
[data source reference](https://developers.notion.com/reference/retrieve-a-data-source).

**Configuration.**
```ts
notionSource({
  token,                                    // from the app (C4)
  notionVersion: '2025-09-03',              // pinned; newer versions exist (2026-03-11), confirm at build time
  dataSources: { feedback: '<data_source_id>', movieNights: '<data_source_id>' },
  exclude: { feedback: ['Internal notes'] }, // optional: properties never exposed
  comments: { feedback: { account: 'matches db.accounts.name' } }, // optional join hints
  useNotionDescriptions: false,             // optional: property descriptions as comments
})
```
The `dataSources` map is the allowlist and plays the role of a GRANT.
- Slime exposes only the data sources listed there.
- That holds even if the integration can see more pages.
- The alias (`feedback`) is the name the model sees.

**`describe()`: the dictionary builds itself.** At startup it calls
`GET /v1/data_sources/{id}` for each listed data source and maps properties to
columns, the way the Postgres connector reads the catalog. Nothing is written
by hand except the optional `exclude` and `comments`. With
`useNotionDescriptions: true`, a property description becomes the column
comment; a `comments` entry overrides it. (Whether the data source endpoint
returns property descriptions is to be confirmed in P5.)

Everything taken from Notion's metadata (property names, option labels,
descriptions, the data source title) is written by Notion users, so before it
enters the dictionary it is made single-line, stripped of control characters
and cut at 200 characters.

| Notion property | Column type | Notes |
|---|---|---|
| title, rich_text | `string` | plain text, runs joined |
| number | `number` | |
| select, status | `string` with `values` = option names | like Postgres enum values (D1) |
| multi_select | `string` | option names joined with ", " |
| date | `date` or `datetime` | start only; `end` becomes `<prop>_end` if needed |
| checkbox | `boolean` | |
| url, email, phone_number, unique_id | `string` | |
| created_time, last_edited_time | `datetime` | |
| relation, people, files, formula, rollup | **excluded in v1** | `people` is personal data; the others need result-type handling |

Every Notion column is nullable, because any cell can be empty. Every row also
gets `id` (the page id), not null, as its primary key.

**Column names.** The property name converted to camelCase ASCII
(`Created date` → `createdDate`). A name with no ASCII letters becomes
`property<N>`, a name starting with a digit gets a `p` prefix, and `id` is
reserved for the page id. If two properties map to the same name, the later
one in Notion's property order gets a numeric suffix (`createdDate2`), so
startup never needs a person.

**Operations.** One per data source: `<alias>.query`. Parameters are generated
from the schema:
- equality on select, status and checkbox properties;
- `<column>_from` / `<column>_to` for date and created_time properties.

Null parameters add no filter. The adapter compiles the non-null parameters
into a Notion `filter` (an `and` of conditions). A model-written filter
language is the alternative (Q5).

**`call()`.** It sends `POST /v1/data_sources/{id}/query` and handles
Notion's limits:
- **Pagination:** `page_size` 100, follows `next_cursor` until the end or
  `rowCap`; `truncated` is set when `rowCap` rows were read and `has_more` is
  still true.
- **Rate limit:** at most 2 requests in flight per Notion source; a 429 is
  retried after `Retry-After` while `apiTimeoutMs` allows.
- **Large results:** a page with `request_status` `incomplete` (Notion's
  10,000-result cap) sets `truncated`.

**`safetyCheck()`.**
- One call, `GET /v1/users/me`: the token is valid; its bot name becomes
  `SafetyReport.user`. A data source that can't be read fails `describe()`, so
  startup makes N+1 calls in total, not 2N+1.
- The token itself can write if the integration has write capabilities. Slime
  stays read-only because the adapter calls only read endpoints, and the
  integration should have only "Read content". Setting that is a documented
  setup step; whether the API can verify it is to be checked in P5.

**Seed data.** `examples/multi-source/scripts/seed-notion.mjs` takes
`NOTION_SEED_TOKEN` (a separate token with insert capability, used only for
seeding) and a parent page id. It reads account names from `DATABASE_URL`,
creates two data sources and prints their ids for `.env`. Slime's own token
stays read-only.
- **Customer feedback:** about 40 entries. Fields: Title; Account (rich text,
  real account names from the demo database); Sentiment (select); Status
  (status, or select if the API can't create status properties); Area
  (multi-select); Created (date).
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

**In the gas and liquid path, no; Crystal is the exception** (table below, S3).
Each source runs separately with its own credentials, the data comes back, and
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

Secrets can still **leak indirectly**, through the adapters and the plumbing
around them. That is what the rules below are for.

### 5.2 Threats and rules

| # | Threat | Rule | Test |
|---|---|---|---|
| S1 | **The model steers a request to another host** (SSRF). If an argument can shape the URL, the adapter sends its `Authorization` header to an attacker's server. | Base URL fixed per source. Arguments only as encoded query or body values. Paths start with one `/` and contain no `//` or `..`; the built URL's origin must equal the base URL's. Cross-origin redirects refused. No URL, host or path parameters. | Query values with `../`, `?`, `#` and full URLs are encoded and keep the host. Paths `//evil.example/x` and `/a/../b` are refused. A redirect to another origin fails. |
| S2 | **Secrets in error text.** HTTP client errors often carry request headers or URLs. Error text reaches the HTTP response (`SlimeError` JSON), startup errors (which `platform/runtime` returns in its 503 body), `onEvent` logs, and the repair prompt sent to the model provider. | Adapters throw `SourceError(status, safeMessage)` with no headers and no raw body. The engine calls every source method (`describe`, `safetyCheck`, `call`, `close`) through one wrapper that redacts the source's `secrets` and wraps the error. The constrained client adds every header value it sends to `secrets`. | The token never appears in a `QueryResult`, `SlimeError.toJSON()`, a startup `SlimeConfigError`, an `onEvent` payload, a store file, or a prompt captured by a spy generator. |
| S3 | **Crystal runs `shape` in-process.** The allowlist is the only wall between model code and `process.env`. | Steps modules keep it: API steps are declared operations in a plain literal, not code, and `shape` passes the same allowlist. Keep the allowlist tests. | `crystal/src/module-format.ts` refuses anything in `steps` that runs. |
| S4 | **Non-JSON objects reach the sandbox** (adapter objects, functions, response objects with headers). | API rows are checked before they cross: a bigint, function, symbol or undefined is refused. SQL rows keep today's handling. | An API row with a function or bigint is refused; a SQL row with a `Date` still works. |
| S5 | **Secrets in the environment** widen the damage of any future bug that reads it. On Lambda, `platform/runtime/src/lambda.ts:30-42` (the Lambda wrapper for Slime Cloud) loads every SSM parameter into `process.env`. | Pass each secret straight to its adapter. Separate follow-up in `platform/runtime`, outside this plan: load only what the runtime needs. | Runtime review item. |
| S6 | **Too much data visible** (a data leak, not a secret leak). | Least privilege per source acts as the GRANT. Postgres: read-only user, as today. Notion: "Read content" only, integration shared only with the listed data sources; Slime exposes only `dataSources` minus `exclude`. `people` properties excluded. | Safety check fails if a listed data source is unreadable. Dictionary snapshot test shows no excluded properties. |
| S7 | **An open explore endpoint.** `POST /slime` in explore mode lets anyone generate queries over everything all sources can read, and spend Notion quota. | R8: explore only in development; locked in production. R11: identity-bound values come from the server. Document this in the example. | Example README states it. A locked-mode test shows no generation. |
| S8 | **Prompt injection through data or metadata.** Notion page text, property names and option labels are written by Notion users, including outside customers. | Rows are never put in prompts. For v2, repair messages carry codes, paths and types, never values (§3.5). Source errors are final and redacted. Notion metadata is made single-line, stripped of control characters and cut at 200 characters before it enters the dictionary; Notion property descriptions are off by default. Every generated handler still passes lint and review. | A spy generator records every prompt while a first attempt is forced to fail over the Notion fixtures, so the repair path runs; no seeded row text appears in any prompt. |
| S9 | **Resource abuse** (quota, memory, time). | `maxSteps`, `rowCap` per step, `statementTimeoutMs` for SQL steps, `apiTimeoutMs` for API steps, at most 2 in-flight Notion requests per source, the QuickJS memory cap. | Cap tests with a fake source. |
| S10 | **Writes.** | API adapters expose only read operations. Notion's adapter calls only `GET` and the query `POST`. | The fixture stub fails the test on any other method or path. |

## 6. Risks and limits

- Notion allows about 3 query requests per second per integration token, shared
  by every Slime instance using it. With 100-row pages, a 1,000-row step takes
  about 4 seconds, inside the 10-second `apiTimeoutMs`; heavy traffic gets 429s
  and then `SOURCE_ERROR`.
- `rowCap` bounds every step. A multi-step handler over a larger data set fails
  with `QUERY_TOO_LARGE` instead of answering wrongly.
- Startup needs every source reachable, in explore and locked mode alike (Q6).
  A Notion outage stops the app from starting, including Lambda cold starts,
  where `platform/runtime` retries startup on each request; Notion startup
  costs N+1 calls (one per data source plus one identity check).
- The Notion schema is read at every start. An edit in Notion (a new property,
  a renamed option) changes `schemaHash`: explore mode regenerates every
  handler; locked mode keeps serving the handlers that still pass the step
  lint and stops serving the rest (§3.3).
- Changing the prompts regenerates explore-mode handlers once, which matters
  for a demo prepared in explore mode.
- People properties are personal data and stay excluded.

## 7. Testing plan

All CI tests run without network access to third parties. Live tests are
opt-in.

| Layer | What | Runs in |
|---|---|---|
| T1 Unit | v2 handler parsing and lint (every rule in §3.5); dictionary rendering and `schemaHash` for API sources (deterministic, data-independent); with no API source, dictionary text and `schemaHash` byte-identical to today; the `shape(data, input)` convention; **v1 compatibility**: two v1 handlers committed under `core/test/fixtures/v1-handlers/` load and run unchanged; redaction. | CI |
| T2 Source contract | A `describeApiSourceContract(options)` suite, like `core/src/testing/connector-contract.ts`. Run against `fakeApiSource`, the Notion adapter and the Ghibli adapter over recorded fixtures. Cases: `describe` is valid and stable; rows match declared types; null params add no filter; `rowCap` sets `truncated`; abort and timeout are honoured; 429 is retried within the timeout, then `SOURCE_ERROR`; no secret in any error; unknown operations or params are rejected; only allowed method and path pairs are called. | CI |
| T3 HTTP fixtures | A fixture `fetch` passed to the constrained client replays recorded JSON, so no server process is needed. Ghibli fixtures are hand-curated (public data). Notion adapter tests first run on hand-written fixtures; a small Notion recorder then records the demo scenario. It scrubs by allowlist (only the fields the adapter reads are kept) and maps real ids to stable placeholder UUIDs in requests and responses alike, so request keys still match. Fixtures are reviewed in the pull request. | CI (replay); manual (record) |
| T4 Engine integration | Postgres demo database (already a CI service) plus `fakeApiSource`, then the Notion and Ghibli fixtures, with a stub generator that returns pre-written handlers. Cases: <br>• the combined query returns the expected output; <br>• repeated runs promote it to liquid, with and without a stub reviewer; <br>• locked mode serves a saved v2 handler; <br>• locked mode refuses a saved v2 handler whose source was removed or whose Notion property was renamed, and startup lists it; <br>• a Notion schema change changes `schemaHash` (explore regenerates, locked warns); <br>• one source down gives a retryable `SOURCE_ERROR` and no partial data; <br>• a truncated step in a two-step handler fails with `QUERY_TOO_LARGE`; <br>• a single-SQL-step v2 artifact is stored as v1, gives the same result and crystallizes. | CI |
| T5 Security | The tests in §5.2's last column, plus the existing sandbox isolation tests. | CI |
| T6 Live | A manual script with `NOTION_TOKEN` and `GROQ_API_KEY` (or `ANTHROPIC_API_KEY`), outside the `npm test` glob. Seed Notion, run the three demo intents (§8) against real Notion, Ghibli and a real model. Check the output shape, non-empty results, and promotion after N runs. Results go into the pull request. | manual |
| T7 Example smoke | `examples/multi-source`: start it, `curl POST /slime` with the demo intents against the fixtures. | CI (new job) |

## 8. Demo scenario

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

## 9. How the code changes, by area

New code goes in `core/src/sources/`; `connectors/` stays as it is (Q9). The
step-by-step plan fixes the exact files per phase; this table names the ones
known so far.

| Area | Change | Files |
|---|---|---|
| Ports | `ApiSource`, `OperationInfo`, `ParamInfo`, `SourceCallOptions`, `CallOptions`, `SourceError`; optional `kind` on `Connector` | `core/src/sources/api/types.ts`, `core/src/sources/sql/types.ts` |
| Config | `sources` (exactly one SQL source), `maxSteps`, `apiTimeoutMs`; `connector` as shorthand; validation of source names | `core/src/config/*` |
| Startup | `describe()` and `safetyCheck()` over every source through the redacting wrapper; locked-mode check of saved v2 handlers | `core/src/create-slime.ts`, `core/src/sources/api/call-source.ts` |
| Dictionary | Render API sources; `schemaHash` over every source; per-source hashes in provenance | `core/src/dictionary/dictionary.ts`, `core/src/request/key.ts` |
| Handler | `Artifact` v2 with steps; single-SQL-step normalization; saved-handler lint on load | `core/src/models/types.ts`, `core/src/engine/types.ts`, `core/src/engine/handler-cache.ts` |
| Errors | `SOURCE_ERROR`, `QUERY_TOO_LARGE`; `FINAL_CODES`; value-free v2 repair messages | `core/src/shared/errors.ts`, `core/src/engine/generation/generate.ts`, `core/src/request/shape.ts` |
| Lint | Step rules (§3.5) | `core/src/artifact/checks/*` |
| Execution | Parallel steps, deadline, abort on any failure, input type check per run, truncation rule, `meta.steps`, `shape(data, input)` | `core/src/engine/execution/execute.ts`, `generate.ts`, `slime-engine.ts` (split), `meta.ts`, `events.ts` |
| Sandbox | The first `shape` argument may be an object of step rows; API rows checked for plain JSON | `core/src/sandbox/types.ts`, `core/src/sandbox/quickjs/quickjs-runner.ts` |
| Models | Generation and review prompts for steps (in a new file); JSON reply format and schema; offline generator accepts v2 | `core/src/models/prompts-multi-source.ts`, `roles.ts`, `schemas.ts`, `offline/` |
| Crystal | Skip handlers with API steps, with a `skipped` outcome (replaced on 2026-11-22 by steps modules) | `crystal/src/crystallize.ts` |
| HTTP | New deadline retry helper; constrained client. `groq-client.ts` is not touched. | `core/src/sources/api/*` |
| Adapters | `defineApiSource`; `notion/` subpath and its export | `core/src/sources/api/*`, `core/src/sources/api/notion/*`, `core/package.json` |
| Testing | `fakeApiSource`, `apiSourceContract`, fixture stub, fixtures | `core/src/testing/*`, `core/test/**`, `core/test/package.test.ts` (new export) |
| CI | Job for `examples/multi-source` | `.github/workflows/ci.yml` |
| Example | `examples/multi-source` with the Ghibli source and seed script | new |
| Docs | This document; `core/PLAN.md` (C12, new decisions); `core/docs/request-format.md` (`meta.steps`, new error codes); `docs/product/concepts_brief.md` (non-goal); READMEs | |

**Public types that change:** `SlimeConfig` options (`sources`, `maxSteps`,
`apiTimeoutMs`), `Connector.kind` (optional), `ShapeJob`, `QueryMeta.steps`,
`GeneratedEvent.steps`, `HandlerRecord.artifact`, `ReviewRequest.artifact`
(custom reviewers that read `.sql` must handle v2), `HandlerProvenance`
(additive `sourceHashes`), `Generator.multiSourcePromptHash` (optional), the
error code union. `config.connector` stays a required `Connector`. Tests that
pin today's prompt text or hashes change only for setups with an API source,
because of the compatibility rule.

## 10. High-level plan

The step-by-step version is
[multi-source-implementation.md](./multi-source-implementation.md).

| Phase | Goal | Exit criteria | Effort |
|---|---|---|---|
| **P0** Decide and spike | Settle §11; amend `core/PLAN.md` C12 and `concepts_brief.md`; write the v2 JSON schema; spike the real v2 schema through the real Claude and Groq clients | §11 marked Decided or Open; PLAN.md diff with MS decisions; spike result recorded | 1.5 d |
| **P1** Sources and dictionary | Compatibility pins first; `sources` config (exactly one SQL source; API sources refused until P3); `ApiSource` port; redacting source wrapper; `fakeApiSource`; dictionary and hashes | With no API source, everything pinned is byte-identical; all existing tests pass | 2.5 d |
| **P2** Handler v2 and execution | Steps, lint, executor, normalization, saved-handler lint, value-free repair errors, meta, Crystal skip, engine split | T1 and the `fakeApiSource` subset of T4 pass; v1 handlers still run | 5 d |
| **P3** Models | Multi-source prompts and schema, second prompt hash, API sources accepted in config | Offline v2 generation works; one manual live generation of a two-source handler | 2 d |
| **P4** Generic API source | Retry helper, constrained client, `defineApiSource`, contract suite, fixture `fetch`; the Ghibli source | Contract passes for the fake and Ghibli; S1, S2, S10 tests pass | 3 d |
| **P5** Notion | Workspace setup; adapter on hand-written fixtures; seed script; recorder and recorded fixtures | Contract passes for Notion; S6, S8 tests pass | 3.5 d |
| **P6** Example, tests, docs | `examples/multi-source` and its CI job; engine tests over fixtures; live run; docs | All CI layers green; the three demo intents answer live and promote to liquid | 2.5 d |
| **Total** | | | **about 20 person-days (18–22), one developer** |

**Order.** P1 → P2 → P3 is the critical path. P4 can start once P1's types
exist. P5 needs P1 and P4. P6 comes last. A second developer can run P4 and P5
alongside P2 and P3.

**Separate follow-up, outside this plan:** S5 in `platform/runtime`.

**Later (P7, not planned yet):**
- dependent steps (arguments bound to earlier steps' columns, with batching);
- Crystal for handlers with API steps (module format, record-and-replay equivalence);
- the OpenAPI importer;
- a Jira adapter;
- regeneration by per-source hash, so one source's change doesn't regenerate
  every handler (the hashes are recorded from P1 on).

**Timing against the demo.** With no API source configured nothing changes,
including `promptHash`, and API sources are refused by config until P3. Each
phase can therefore merge to `main` on its own without touching a demo that
uses only Postgres (Q10).

## 11. Open questions

Every question carries a recommendation. P0 recorded each one as a decision in [core/PLAN.md §3.1](../PLAN.md) (status Proposed there); Q13 stays open until P5.

| # | Question | Recommendation | Status |
|---|---|---|---|
| Q1 | Uniform `steps` for every handler, or keep top-level `sql` and add `calls`? | `steps` for v2 only; v1 artifacts stay as they are when no API source is configured (§3.3). | Recorded: MS3 in core/PLAN.md |
| Q2 | How many SQL sources? | Exactly one in v1: one dialect in prompts and lint, and `config.connector` stays required. | Recorded: MS1 |
| Q3 | Constants in API arguments? | Yes, typed and checked against `values`. Otherwise intents like "open negative feedback" need extra inputs. | Recorded: MS4 |
| Q4 | List-valued columns (multi_select, relation)? | No list columns in v1: multi_select is a joined string, relation is excluded. | Recorded: MS2 |
| Q5 | Notion filters: generated equality and range params, or a model-written filter language? | Generated params in v1. Small, typed, lintable. Anything finer is done in `shape` over at most `rowCap` rows; more data fails the run (§3.5). | Recorded: MS12 |
| Q6 | A source is down at startup? | Fail fast in explore and locked mode, matching today's behaviour when the database is unreachable. | Recorded: MS8 |
| Q7 | Crystal for handlers with API steps? | Not in v1 (S3, and equivalence on live data is not deterministic). Since 2026-11-22: yes, as steps modules (§3.6). | Recorded: MS9, replaced |
| Q8 | Can a `defineApiSource` operation use raw `fetch`? | No. Only the constrained client, which takes headers, method and body options. | Recorded: MS10 |
| Q9 | Naming and folders: "source" vs "connector"; `connectors/` vs `sources/`? | "Source" is the umbrella term, and the Postgres connector is a SQL source. New code goes in `core/src/sources/`. | Recorded: MS11 |
| Q10 | Merge before or after the demo? | Phase by phase as each is ready: the compatibility rule and the P1–P3 config guard keep a Postgres-only demo unchanged. | Recorded: Plan §0 |
| Q11 | Expose Notion `people` properties? | Excluded by default; opt in per property later. | Recorded: MS12 |
| Q12 | The exact JSON schema of the v2 artifact and of `meta.steps`? | Write it in P0 as an addition to `core/docs/request-format.md`. | Recorded: Answered in core/docs/request-format.md (P0.2) |
| Q13 | Does Notion's data source endpoint return property descriptions? | Check in P5. Descriptions are opt-in (`useNotionDescriptions`); join hints come from `comments` either way. | Open |
| Q14 | API timeout? | A new limit `apiTimeoutMs`, default 10 s, for API steps and for source `describe` and `safetyCheck`. | Recorded: MS5 |

## 12. Glossary

- **Source:** a named data provider, either SQL or API. In config, `sources` is
  the map of them.
- **Operation:** a named, typed read an API source offers. Its arguments go in
  and flat rows come out.
- **Step:** one read in a handler: a SQL query or an operation call.
- **Adapter:** the code that implements a source, written by people. It holds
  the credentials.
