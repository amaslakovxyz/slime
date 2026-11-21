# Multi-source handlers: concept and high-level plan

| | |
|---|---|
| Status | **Design** (draft for review; not on main) |
| Owner | Konstantin |
| Date | 2026-11-21 (revised after the review in PR #26) |
| Scope | `core/` (`@slime-cloud/core`), one new adapter subpath, one example app |
| Next step | Settle §11 in P0, then turn §10 into a step-by-step implementation plan |

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
compatibility rule). Crystal for handlers that call APIs is deferred to a later
phase.

The first build targets three sources:
- **Postgres**: the demo billing database from `examples/express`.
- **Notion**: a seeded workspace, as the first API source shipped in core. Its
  dictionary is built from Notion's own schema at startup, as the database's
  is built from the catalog.
- **Studio Ghibli films API**: public and keyless, wrapped by the example app.
  It shows that a second, very different API fits the same interface with
  about 30 lines of app code.

Estimated effort: **9.5–13.5 person-days** for one developer, phases P0–P6
(§10).

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
- Crystal for handlers with API steps. Listed under P7.
- More than one SQL source, and cross-database SQL.
- Non-HTTP sources (CSV, Excel, DuckDB). A separate track.
- Importing an OpenAPI spec automatically. Listed under P7.

## 2. Where we start

Key facts about core today (main @ 441c84b):

| Part | Today | File |
|---|---|---|
| Source | One `Connector`: `describe()`, `check(sql)`, `run(sql)`, `safetyCheck()`, `close()` | `core/src/connectors/types.ts` |
| Handler | `Artifact = { unsatisfiable, sql, params, shapeJs, assumptions }` | `core/src/models/types.ts` |
| Dictionary | Tables, columns, keys, enum values, comments, glossary and rules, rendered as text; `schemaHash = sha256(schema)` | `core/src/dictionary/dictionary.ts` |
| Execution | `connector.run(sql)`, then `shape(rows, input)` in QuickJS, then output validation | `core/src/engine/execute.ts` |
| Generation | Generate, lint, `check` (cost), run; on failure the error text goes back to the model for repair | `core/src/engine/generate.ts` |
| Sandbox | QuickJS (WASM) in worker threads; JSON in, JSON out; no `process`, `require` or `fetch` (tested) | `core/src/sandbox/quickjs/*`, `core/test/sandbox/quickjs.test.ts` |
| Lifecycle | Gas → liquid after `gasToLiquidRuns` successful runs, plus an approved review if a reviewer is set. Knows nothing about sources. | `core/src/engine/lifecycle.ts` |
| Crystal | A liquid handler rewritten into a JS module committed to the app: `sql` + in-process `shape`. Checked by an allowlist, SQL lint and an equivalence test that replays recorded inputs and compares results with the original. | `core/src/engine/crystal/*`, `core/src/crystallize/*` |

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
| C10 (Crystal) | Limited: handlers with API steps are not crystallized in v1. |
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
  - `sql`: today's `Connector`. Its `kind` is optional and defaults to `'sql'`,
    so existing custom connectors compile unchanged.
  - `api`: a new port.
- **Proposed API source port.** It reuses `ColumnInfo`, `RunResult` and
  `SafetyReport` from `connectors/types.ts`:

```ts
interface ApiSource {
  readonly kind: 'api';
  readonly name: string;                       // adapter name, e.g. "notion"
  readonly secrets: readonly string[];         // values core redacts from every message and event (S2)
  describe(): Promise<ApiSchema>;              // metadata only, never rows (D1)
  call(operation: string, args: Readonly<Record<string, unknown>>, options: CallOptions): Promise<RunResult>;
  safetyCheck(): Promise<SafetyReport>;        // the token works and every listed data set is readable
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
- **`shape` calling convention.** An artifact with a `steps` field is v2 and
  gets `shape(data, input)`, where `data` is `{ [stepName]: rows[] }`. An
  artifact without one is v1 and keeps `shape(rows, input)`.
- **When `shapeJs` may be null.** It is required when there is more than one
  step. With one step it may be null, as today.
- **Crystal.** A v2 artifact whose only step is SQL is crystallized like a v1
  artifact. Artifacts with an API step are skipped in v1 (§3.6).
- **Storage.** Handlers stay in the same store, keyed by the same request key.
  A stored v2 handler holds names, SQL text, argument bindings and code. It
  never holds credentials or row data, so `.slime/` stays safe to commit.
- **Rollback.** A core without this change cannot read v2 handlers. When
  downgrading, clear `.slime/` or keep only v1 handlers.

### 3.4 Dictionary for API sources

Slime renders the dictionary for every source in one format, with no model
(D2). API operations use the same column format as tables today
(`name type null|not null [primary key] [one of: …] [-- comment]`). Example
for the demo:

```
Database: postgresql 16
Table accounts
  id integer not null primary key
  name text not null
  ...

API source notion: Notion API 2025-09-03 (read-only access)
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

API source films: Studio Ghibli API (public, read-only)
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

### 3.5 Generation, lint and execution

**Generation.** The flow does not change: generate, lint, check, run, repair.
- The generation prompt learns about steps, operations and `shape(data, input)`.
- The model sees the dictionary, the intent, input names and types, and the
  output shape. Rows are never put in the prompt. A failed attempt's error text
  goes back to the model for repair and can contain values from rows or input,
  as it does today (`generate.ts`, `quickjs-runner.ts`). Source errors are
  redacted (S2) and final, so they never reach the repair prompt.

**Lint.** Model-free and deterministic. It adds these checks to today's SQL lint:
- Step names are unique identifiers.
- Each step's source exists and is of the right kind.
- The operation exists, and its arguments name declared parameters.
- Every `input` binding names an input key, and the input's type matches the
  parameter's type (the existing parameter type checks); a mismatch is
  `INVALID_REQUEST`.
- Constants match the parameter's type and `values`.
- No input value appears hard-coded in a constant. Today's hard-coded-value
  rule covers constants too.
- `shapeJs` is present when there is more than one step.
- There are at most `maxSteps` steps (the only new limit, default 4).
- SQL steps also go through today's SQL lint.

**Check.** SQL steps go through `connector.check` (cost), as today. API steps
have no cost estimate. Each step is bounded by existing limits: `rowCap` rows
and `statementTimeoutMs` time (API calls use it as their timeout). The combined
data is bounded by `shapeMemoryBytes` in the sandbox.

**Execution.**
1. All steps run in parallel under one deadline. If an API step fails, the
   other API steps get an aborted `AbortSignal`. A running SQL step is not
   cancelled (`Connector.run` takes no signal); its result is discarded.
2. Rows must be plain JSON to cross into the sandbox, as today. Adapter
   correctness is covered by the contract suite (T2), not a runtime check.
3. Timeouts, 429s after retry, and 5xx become `SOURCE_ERROR`: HTTP 502,
   `retryable: true` (a hint to the caller of the HTTP endpoint), and final
   during generation (added to `FINAL_CODES`), because the model can't fix an
   outage. There is no partial data.
4. If any step is truncated and the handler has more than one step, the run
   fails with `QUERY_TOO_LARGE` (HTTP 422, not retryable, final). `rowCap` is
   therefore the largest data set one step may read in v1. A single-step
   handler keeps today's behaviour: rows are cut and `meta.truncated` is true.
5. `shape` runs, then today's output validation and the R6 limit check.
6. In explore mode, `meta.steps` lists each step's source, row count and time.

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
| Locked | Serves saved v2 handlers like any other. Adapters still run, so sources must be reachable. |
| Crystal | v1: handlers with an API step are skipped and reported; a single-SQL-step v2 handler is crystallized as today. P7 adds a module format for API steps with record-and-replay equivalence. |

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
- It only reaches `baseUrl`.
- It encodes query values, and validates path segments against a pattern.
- It refuses redirects to other origins.
- It applies the step timeout and `signal`, a response-size cap and JSON parsing.
- It retries a 429 after `Retry-After` while the timeout allows.
- It turns failures into redacted `SourceError`s.

The timeout, abort and `Retry-After` handling already exist inline in
`core/src/models/groq/groq-client.ts`; P4 extracts them into a shared helper
that both use, instead of writing them again. An adapter that needs more
(custom auth, a POST body) gets options on the client: headers, method and
body. There is no raw `fetch` (Q8).

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
})
```
The `dataSources` map is the allowlist and plays the role of a GRANT.
- Slime exposes only the data sources listed there.
- That holds even if the integration can see more pages.
- The alias (`feedback`) is the name the model sees.

**`describe()`: the dictionary builds itself.** At startup it calls
`GET /v1/data_sources/{id}` for each listed data source and maps properties to
columns, the way the Postgres connector reads the catalog. Nothing is written
by hand except the optional `exclude` and `comments`. If Notion returns a
property description, it becomes the column comment; a `comments` entry
overrides it. (Whether the data source endpoint returns property descriptions
is to be confirmed in P5.)

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
(`Created date` → `createdDate`). If two properties map to the same name, the
later one in Notion's property order gets a numeric suffix (`createdDate2`), so
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
- **Pagination:** follows `start_cursor` until the end or `rowCap`.
- **Rate limit:** a 429 is retried after `Retry-After` while the step timeout
  allows.
- **Large results:** a page with `request_status` `incomplete` (Notion's
  10,000-result cap) sets `truncated`.

**`safetyCheck()`.**
- The token is valid.
- Every listed data source can be retrieved.
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
  (status); Area (multi-select); Created (date).
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
| S1 | **The model steers a request to another host** (SSRF). If an argument can shape the URL, the adapter sends its `Authorization` header to an attacker's server. | Base URL fixed per source. Arguments only as encoded query or body values; path segments validated against a pattern. Cross-origin redirects refused. No URL, host or path parameters. | Input values with `../`, `?`, `#` and full URLs reach the fixture stub encoded, on the same host. A redirect to another origin fails. |
| S2 | **Secrets in error text.** HTTP client errors often carry request headers or URLs. Error text reaches the HTTP response (`SlimeError` JSON), `onEvent` logs, and the repair prompt sent to the model provider. | Adapters throw `SourceError(status, safeMessage)` with no headers and no raw body. Core redacts each source's `secrets` from every message and event. | The token never appears in a `QueryResult`, `SlimeError.toJSON()`, an `onEvent` payload, a store file, or a prompt captured by a spy generator. |
| S3 | **Crystal runs `shape` in-process.** The allowlist is the only wall between model code and `process.env`. | v1: no Crystal for handlers with API steps. Keep the allowlist tests. | Crystallize skips handlers with API steps and reports them. |
| S4 | **Non-JSON objects reach the sandbox** (adapter objects, functions, response objects with headers). | `ShapeJob` carries only `JSON.stringify`-able rows. | A row with a function or bigint is rejected before the sandbox. |
| S5 | **Secrets in the environment** widen the damage of any future bug that reads it. On Lambda, `platform/runtime/src/lambda.ts:30-42` (the Lambda wrapper for Slime Cloud) loads every SSM parameter into `process.env`. | Pass each secret straight to its adapter. Separate follow-up in `platform/runtime`, outside this plan: load only what the runtime needs. | Runtime review item. |
| S6 | **Too much data visible** (a data leak, not a secret leak). | Least privilege per source acts as the GRANT. Postgres: read-only user, as today. Notion: "Read content" only, integration shared only with the listed data sources; Slime exposes only `dataSources` minus `exclude`. `people` properties excluded. | Safety check fails if a listed data source is unreadable. Dictionary snapshot test shows no excluded properties. |
| S7 | **An open explore endpoint.** `POST /slime` in explore mode lets anyone generate queries over everything all sources can read, and spend Notion quota. | R8: explore only in development; locked in production. R11: identity-bound values come from the server. Document this in the example. | Example README states it. A locked-mode test shows no generation. |
| S8 | **Prompt injection through data or metadata.** Notion page text, property names and option labels are written by Notion users. | Rows are never put in prompts. Source errors are final and redacted, so they never reach the repair prompt. Property names and option labels do reach the dictionary: only people the integration's pages are shared with can edit them, and every generated handler still passes lint and review. | Spy generator: no seeded row text appears in any prompt. |
| S9 | **Resource abuse** (quota, memory, time). | `maxSteps`, the existing `rowCap` and `statementTimeoutMs` per step, the QuickJS memory cap. | Cap tests with a fake source. |
| S10 | **Writes.** | API adapters expose only read operations. Notion's adapter calls only `GET` and the query `POST`. | The fixture stub fails the test on any other method or path. |

## 6. Risks and limits

- Notion allows about 3 query requests per second per integration token, shared
  by every Slime instance using it. With 100-row pages, a 1,000-row step takes
  about 4 seconds; heavy traffic gets 429s and then `SOURCE_ERROR`.
- `rowCap` bounds every step. A multi-step handler over a larger data set fails
  with `QUERY_TOO_LARGE` instead of answering wrongly.
- Startup needs every source reachable (Q6). A Notion outage stops the app from
  starting, including Lambda cold starts.
- The Notion schema is read at every start. An edit in Notion (a new property,
  a renamed option) changes `schemaHash`: explore mode regenerates every
  handler; locked mode keeps serving and warns.
- Changing the prompts regenerates explore-mode handlers once, which matters
  for a demo prepared in explore mode.
- People properties are personal data and stay excluded.

## 7. Testing plan

All CI tests run without network access to third parties. Live tests are
opt-in.

| Layer | What | Runs in |
|---|---|---|
| T1 Unit | v2 handler parsing and lint (every rule in §3.5); dictionary rendering and `schemaHash` for API sources (deterministic, data-independent); with no API source, dictionary text and `schemaHash` byte-identical to today; the `shape(data, input)` convention; **v1 compatibility**: two v1 handlers committed under `core/test/fixtures/v1-handlers/` load and run unchanged; redaction. | CI |
| T2 Source contract | An `apiSourceContract(source, fixtures)` suite, like `core/src/testing/connector-contract.ts`. Run against `fakeApiSource`, the Notion adapter and the Ghibli adapter over recorded fixtures. Cases: `describe` is valid and stable; rows match declared types; null params add no filter; `rowCap` sets `truncated`; abort and timeout are honoured; 429 is retried within the timeout, then `SOURCE_ERROR`; no secret in any error; unknown operations or params are rejected; only allowed method and path pairs are called. | CI |
| T3 HTTP fixtures | A fixture stub inside the constrained client replays recorded JSON, so no server process is needed. Fixtures live in `core/test/fixtures/<source>/`. `npm run record:fixtures -- <source>` records one source at a time (Ghibli needs no token; Notion needs `NOTION_TOKEN`), scrubs tokens and ids, and the fixtures are committed. | CI (replay); manual (record) |
| T4 Engine integration | Postgres demo database (already a CI service) plus `fakeApiSource`, then the Notion and Ghibli fixtures, with the offline generator (a stub generator that returns pre-written handlers) holding v2 handlers. Cases: <br>• the combined query returns the expected output; <br>• repeated runs promote it to liquid, with and without a stub reviewer; <br>• locked mode serves a saved v2 handler; <br>• a Notion schema change changes `schemaHash` (explore regenerates, locked warns); <br>• one source down gives a retryable `SOURCE_ERROR` and no partial data; <br>• a truncated step in a two-step handler fails with `QUERY_TOO_LARGE`; <br>• a single-SQL-step v2 handler is crystallized. | CI |
| T5 Security | The tests in §5.2's last column, plus the existing sandbox isolation tests. | CI |
| T6 Live | `LIVE=1` with `NOTION_TOKEN` and `GROQ_API_KEY` (or `ANTHROPIC_API_KEY`). Seed Notion, run the three demo intents (§8) against real Notion, Ghibli and a real model. Check the output shape, non-empty results, and promotion after N runs. Add the intents as bench cases in `core/bench/`. | manual / nightly |
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
| Ports | `ApiSource`, `OperationInfo`, `ParamInfo`, `CallOptions`, `SourceError`; optional `kind` on `Connector` | `core/src/sources/types.ts`, `core/src/connectors/types.ts` |
| Config | `sources`, `maxSteps`; `connector` as shorthand; validation of source names | `core/src/config/*` |
| Startup | `describe()` and `safetyCheck()` over every source | `core/src/create-slime.ts` |
| Dictionary | Render API sources; `schemaHash` over every source | `core/src/dictionary/dictionary.ts` |
| Handler | `Artifact` v2 with steps; v1 read path | `core/src/models/types.ts`, `core/src/engine/types.ts` |
| Errors | `SOURCE_ERROR`, `QUERY_TOO_LARGE`; `FINAL_CODES` | `core/src/shared/errors.ts`, `core/src/engine/generate.ts` |
| Lint | Step rules (§3.5) | `core/src/engine/checks/*` |
| Execution | Parallel steps, deadline, abort for API steps, truncation rule, redaction, `meta.steps`, `shape(data, input)` | `core/src/engine/execute.ts`, `generate.ts`, `slime-engine.ts`, `meta.ts` |
| Sandbox | `ShapeJob` carries `rows` (v1) or `data` (v2) | `core/src/sandbox/types.ts`, `core/src/sandbox/quickjs/quickjs-runner.ts` |
| Models | Generation and review prompts for steps; JSON reply format and schema; offline generator accepts v2 | `core/src/models/prompts.ts`, `roles.ts`, `offline/` |
| Crystal | Skip handlers with API steps, with an event; crystallize single-SQL-step v2 handlers | `core/src/crystallize/crystallize.ts` |
| HTTP | Shared timeout, abort and `Retry-After` helper extracted from `groq-client.ts`; constrained client | `core/src/shared/http.ts`, `core/src/models/groq/groq-client.ts`, `core/src/sources/api/*` |
| Adapters | `defineApiSource`; `notion/` subpath and its export | `core/src/sources/api/*`, `core/src/sources/notion/*`, `core/package.json` |
| Testing | `fakeApiSource`, `apiSourceContract`, fixture stub, fixtures | `core/src/testing/*`, `core/test/**`, `core/test/package.test.ts` (new export) |
| CI | Job for `examples/multi-source` | `.github/workflows/ci.yml` |
| Example | `examples/multi-source` with the Ghibli source and seed script | new |
| Docs | This document; `core/PLAN.md` (C12, new decisions); `core/docs/request-format.md` (`meta.steps`, new error codes); `docs/product/concepts_brief.md` (non-goal); READMEs | |

**Public types that change:** `SlimeConfig` options (`sources`, `maxSteps`),
`Connector.kind` (optional), `ShapeJob`, `QueryMeta.steps`, the error code
union. Tests that pin today's prompt text or hashes change only for setups with
an API source, because of the compatibility rule.

## 10. High-level plan

| Phase | Goal | Exit criteria | Effort |
|---|---|---|---|
| **P0** Decide and spike | Review this document; settle §11; amend `core/PLAN.md` C12 and `concepts_brief.md`. Half-day spike: hand-write the dictionary for `db` + one API source and check that the model returns a valid two-step handler for the demo intents. | Each §11 question marked Decided or Open with an owner; a `core/PLAN.md` diff adding decision IDs MS1–MSn (one per decided question and per rule in §3.5 and §3.6); spike result recorded. | 1 d |
| **P1** Sources and dictionary | `sources` config with `connector` shorthand; optional `kind`; `ApiSource` port; `fakeApiSource` (in-memory, `core/src/testing`); dictionary renders API sources; `schemaHash` over all sources | Dictionary tests updated for API sources; with no API source, dictionary text and `schemaHash` byte-identical to today; all other existing tests pass unchanged | 1–1.5 d |
| **P2** Handler v2 and execution | Steps, lint, parallel execution, truncation rule, `SOURCE_ERROR`, redaction, `shape(data, input)`, `meta.steps`; v1 compatibility; Crystal skip and single-SQL-step crystallization; v1 handler fixtures | T1 and the `fakeApiSource` subset of T4 pass; v1 handlers still run; S3, S4, S9 tests pass | 2–3 d |
| **P3** Models | Prompts, reply schemas and the offline generator for v2 | Offline v2 generation works; one live generation of a two-source handler against `db` + `fakeApiSource` | 1–1.5 d |
| **P4** Generic API source | Shared HTTP helper, constrained client, `defineApiSource`, `apiSourceContract`, fixture stub; the Ghibli source and its fixtures | T2 passes for `fakeApiSource` and Ghibli; S1, S2, S10 tests pass | 1–1.5 d |
| **P5** Notion | `@slime-cloud/core/notion` and its export: describe mapping, column names, filter compilation, pagination, safety check; seed script; recorded fixtures | T2 passes for Notion; S6, S8 tests pass; recording works against a real workspace | 2–3 d |
| **P6** Example, tests, docs | `examples/multi-source` and its CI job; T4 with the Notion and Ghibli fixtures, T5, T7 in CI; T6 live run; docs | All CI layers green; the three demo intents answer live and promote to liquid | 1.5–2 d |
| **Total** | | | **9.5–13.5 person-days, one developer** |

**Order.** P1 → P2 → P3 is the critical path. P4 can start once P1's types
exist. P5 needs P1, and P4's HTTP client and contract suite. P6 comes last. A
second developer can run P4 and P5 alongside P2 and P3.

**Separate follow-up, outside this plan:** S5 in `platform/runtime`.

**Later (P7, not planned yet):**
- dependent steps (arguments bound to earlier steps' columns, with batching);
- Crystal for handlers with API steps (module format, record-and-replay equivalence);
- the OpenAPI importer;
- a Jira adapter;
- per-source schema hashes, so one source's change doesn't regenerate every handler.

**Timing against the demo.** Changing the prompts changes `promptHash`, so a
demo that runs in explore mode would regenerate its prepared handlers. Build on
a branch and decide the merge date with the demo owner (Q10).

## 11. Open questions

Every question carries a recommendation; P0 marks each Decided or Open.

| # | Question | Recommendation | Status |
|---|---|---|---|
| Q1 | Uniform `steps` for every handler, or keep top-level `sql` and add `calls`? | `steps` for v2 only; v1 artifacts stay as they are when no API source is configured (§3.3). | Recommended |
| Q2 | More than one SQL source? | Not in v1. One SQL source keeps one dialect in prompts and lint. | Recommended |
| Q3 | Constants in API arguments? | Yes, typed and checked against `values`. Otherwise intents like "open negative feedback" need extra inputs. | Recommended |
| Q4 | List-valued columns (multi_select, relation)? | No list columns in v1: multi_select is a joined string, relation is excluded. | Decided in this revision |
| Q5 | Notion filters: generated equality and range params, or a model-written filter language? | Generated params in v1. Small, typed, lintable. Anything finer is done in `shape` over at most `rowCap` rows; more data fails the run (§3.5). | Recommended |
| Q6 | A source is down at startup? | Fail fast, matching today's behaviour when the database is unreachable. | Recommended |
| Q7 | Crystal for handlers with API steps? | Not in v1 (S3, and equivalence on live data is not deterministic). | Recommended |
| Q8 | Can a `defineApiSource` operation use raw `fetch`? | No. Only the constrained client, which takes headers, method and body options. | Recommended |
| Q9 | Naming and folders: "source" vs "connector"; `connectors/` vs `sources/`? | "Source" is the umbrella term, and the Postgres connector is a SQL source. New code goes in `core/src/sources/`. | Recommended |
| Q10 | Merge before or after the demo? | After, unless the demo needs it and runs in locked mode. | Recommended |
| Q11 | Expose Notion `people` properties? | Excluded by default; opt in per property later. | Recommended |
| Q12 | The exact JSON schema of the v2 artifact and of `meta.steps`? | Write it in P0 as an addition to `core/docs/request-format.md`. | Open |
| Q13 | Does Notion's data source endpoint return property descriptions? | Check in P5; if not, join hints come only from `comments`. | Open |

## 12. Glossary

- **Source:** a named data provider, either SQL or API. In config, `sources` is
  the map of them.
- **Operation:** a named, typed read an API source offers. Its arguments go in
  and flat rows come out.
- **Step:** one read in a handler: a SQL query or an operation call.
- **Adapter:** the code that implements a source, written by people. It holds
  the credentials.
