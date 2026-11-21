# Multi-source handlers: step-by-step implementation plan

| | |
|---|---|
| Status | **Plan** (revision 2, after the architect and staff-engineer reviews; not started) |
| Design | [multi-source.md](./multi-source.md), revised together with this plan |
| Owner | Konstantin |
| Date | 2026-11-21 |
| Effort | about 20 person-days (18–22) for one developer, phases P0–P6 |

This plan turns §10 of the design into steps that an engineer or a coding agent
can take one at a time. Each step names its files, what changes, the tests that
prove it, and when it is done. Read the design first. This plan says what to do
and where; the design says why.

Revision 2 applies every finding of the architect and staff-engineer reviews.
What changed is listed in §12.

## 0. How to use this plan

**Rules for every step.**
- Work in a worktree under `.worktrees/<branch-slug>/`, one branch per phase
  (`feat/ms-p1-sources`, `feat/ms-p2-steps`, …). Open one pull request per
  phase against `main` ([AGENTS.md](../../AGENTS.md)).
- Follow [core/AGENTS.md](../AGENTS.md):
  - named constants;
  - named interfaces at module boundaries, with no inline object types in
    exported signatures;
  - options objects past three parameters;
  - files under about 150 lines, split past 200;
  - comments only for *why*;
  - decision IDs as `// MS6`.
- Each phase ends green on four checks:
  - `npm run typecheck -w @slime-cloud/core`;
  - `npm test -w @slime-cloud/core`;
  - `npm run check:pack -w @slime-cloud/core`;
  - in `platform/runtime`, `npm run typecheck` and `npm test`.

  Then `pre-commit run --all-files`.

**Merging phase by phase is safe.** Two rules make it so:
- **The compatibility rule (design §3.3).** With no API source configured,
  Slime is byte-identical to today. Step P1.0 pins this before any change.
- **The config guard.** Config refuses API sources with "not yet supported"
  from P1 until P3.3 removes the rule, so `main` never exposes a half-built
  feature.

A Postgres-only demo is therefore unaffected by any merge.

**Step format.** Every step has the same four parts:
- **Files**: what to create or edit.
- **Change**: what to write.
- **Tests**: which tests prove it.
- **Done when**: the check that closes the step.

Effort is per step, in hours (h).

## 1. Decisions this plan assumes

P0 records these in [core/PLAN.md](../PLAN.md) as a new table, "MS —
multi-source". If P0 changes one, update the steps that cite it.

| ID | Decision | Design ref |
|---|---|---|
| MS1 | `sources` config: exactly one SQL source and any number of API sources; `connector: x` means `sources: { db: x }`; `config.connector` stays a required `Connector` | §3.2, G1, Q2 |
| MS2 | API source port and contract: flat rows of plain JSON, output-notation leaf types, nullable where declared, no list columns; `describe` and `safetyCheck` take `{ timeoutMs, signal }` | §3.2, Q4 |
| MS3 | v2 artifact `{ version: 2, steps, … }`, produced only when an API source is configured. A single-SQL-step v2 artifact is converted to v1 (nested `shape`) before its first run. | §3.3, Q1 |
| MS4 | API arguments are a list of `{ param, input, value }`, with exactly one of `input` and `value` set; constants are checked against type and `values` | §3.3, Q3 |
| MS5 | New limits: `maxSteps` (default 4) and `apiTimeoutMs` (default 10 000). SQL steps keep `statementTimeoutMs`; every step keeps `rowCap`. | §3.5, Q14 |
| MS6 | A truncated step in a multi-step handler fails with `QUERY_TOO_LARGE` (422). It is repairable during generation. | §3.5 |
| MS7 | `SOURCE_ERROR` (502): retryable for 429, 5xx and timeouts, not retryable for other 4xx; final during generation; redacted | §3.5, S2 |
| MS8 | Startup fails if any source fails `describe()` or `safetyCheck()`, in explore and locked mode | Q6 |
| MS9 | No Crystal for handlers with an API step | §3.6, Q7 |
| MS10 | API adapters reach the network only through the constrained client: origin check, no `//` or `..`, same-origin redirects only, 10 MB cap | §4.1, Q8, S1 |
| MS11 | New code lives in `core/src/sources/` | Q9 |
| MS12 | Notion: schema discovered at startup; generated equality and range params; metadata sanitized; descriptions opt-in; at most 2 requests in flight; `people`, `relation`, `files`, `formula`, `rollup` excluded | §4.2, Q5, Q11, Q13 |
| MS13 | Cross-source join hints are column comments | §3.2 |
| MS14 | Saved v2 handlers are re-linted against today's sources on load and at locked startup; failures are not served | §3.3 |
| MS15 | v2 repair messages carry codes, paths and types, never values | §3.5, S8 |
| MS16 | Every source method is called through one redacting wrapper; the constrained client adds its header values to `secrets` | S2 |
| MS17 | Provenance records per-source hashes (`sourceHashes`); Crystal's schema warning compares only the SQL source's hash | §3.4 |

## 2. Phase P0: decide and spike (1.5 d)

### P0.1 Record decisions (2 h)
- **Files:** `core/PLAN.md`, `docs/product/concepts_brief.md`, `core/docs/multi-source.md` (§11 statuses).
- **Change:**
  - Add the MS1–MS17 table to PLAN.md §3.
  - Set C12 to "Amended by MS1".
  - In concepts_brief.md, replace the non-goal "Connectors other than Postgres"
    with "Write connectors; non-HTTP sources (see core/docs/multi-source.md)".
  - Mark design §11 questions Decided with their MS IDs.
- **Done when:** the PLAN.md diff is merged in the P0 pull request.

### P0.2 Write the v2 artifact and meta schema (2 h)
- **Files:** `core/docs/request-format.md`.
- **Change:** add a section "Multi-source handlers":
  - The v2 artifact:
    ```jsonc
    {
      "version": 2,
      "unsatisfiable": null | "<one sentence>",
      "steps": [
        { "name": "<identifier>", "source": "<source name>", "sql": "<SELECT>", "params": ["<input name>"] },
        { "name": "<identifier>", "source": "<source name>", "operation": "<operation name>",
          "args": [ { "param": "<param>", "input": "<input name>" | null, "value": <string|number|boolean> | null } ] }
      ],
      "shapeJs": "function shape(data, input) { … }" | null,
      "assumptions": ["…"]
    }
    ```
    Every object is closed: no keys beyond those shown.
  - `meta.steps` (explore mode only): one entry per step:
    `{ "name", "source", "rows", "ms", "sql"? , "operation"?, "args"? }`.
  - `SOURCE_ERROR`: 502; `retryable` per MS7; details hold `source`,
    `operation`, `status` and `attempts`.
  - `QUERY_TOO_LARGE`: 422, not retryable; details hold `step`.
- **Done when:** the section is reviewed. P2.2 and P2.8 implement exactly this.

### P0.3 Spike with the real schema and clients (6 h)
- **Files:** `core/bench/spikes/multi-source-prompt.mjs` (new; not shipped, not
  under `test/`, not in CI). It imports from the built `dist/`.
- **Change:**
  1. Write the `ArtifactV2Schema` zod schema exactly as P0.2 defines it, in the
     spike file; P2.2 moves it into core.
  2. Write draft v2 generation instructions, the text P3.1 will refine.
  3. Hand-write a dictionary: the demo `db`, plus the Notion `feedback` and
     `movieNights` operations and the Ghibli `films.list` operation, as in
     design §3.4.
  4. Call the real `claudeClient` and `groqClient` (`core/src/models/claude`,
     `groq`) through `modelRoles`, with the schema passed as `ModelCall.schema`.
     This proves that both providers accept the schema in structured output.
  5. Ask the three demo intents (design §8) on both providers and validate each
     reply with the schema.
- **Done when:** both providers accept the schema (no schema rejection), and at
  least 2 of the 3 intents return a plausible two-step artifact on at least one
  provider. Paste the replies into the pull request. If either check fails,
  stop and revise the artifact format before P1.
- **Result (2026-11-21): passed, with one finding and one open check.**
  - **Groq** (`openai/gpt-oss-120b`, prompt-mode JSON validated with the
    schema), three runs:

    | Run | Intent 1 (db + notion) | Intent 2 (notion + films) | Intent 3 (films) |
    |---|---|---|---|
    | 1 | wrong source name (`postgresql`) | pass | pass |
    | 2 | pass | pass | pass |
    | 3 | pass | pass | Groq rate limit |

    "Pass" means the reply matched the schema, passed the step lint, used the
    expected sources, and ran end to end: SQL against the demo database,
    canned API rows, `shape` in QuickJS, and output validation. Intent 1's
    handler pushed the `negative` and `Open` filters to Notion as constants,
    joined on the `matches db.accounts.name` hint, and sorted correctly.
  - **Finding.** Run 1 failed because today's dictionary heading
    (`Database: postgresql 16`) doesn't name the SQL source. With API sources
    configured, the heading becomes `Database db: postgresql 16` (P1.5,
    design §3.4). Runs 2 and 3 used that heading.
  - **Claude.** No API key was available, so there was no live call. The
    schema converts with `betaZodOutputFormat` with every object closed
    (`additionalProperties: false`). One live Claude call is still to do; P3.2's
    tests and the P3.4 live run cover it.
  - The spike is `core/bench/spikes/multi-source-prompt.mjs`.

## 3. Phase P1: sources and dictionary (2.5 d)

### P1.0 Compatibility pins, first (2 h)
- **Files:** `core/test/models/prompt-hash.test.ts`, `core/test/dictionary/dictionary.test.ts`, new `core/test/compat/v1-model-call.test.ts`.
- **Change:** do this before any other P1 change, on a commit that touches no
  source file.
  - Extend the existing pins (`prompt-hash.test.ts:11-17`,
    `dictionary.test.ts:24-35`) rather than duplicating them.
  - Add one test that captures the full `ModelCall` a v1 generation and a v1
    review send: instructions, `context`, message and schema. Capture it with
    a fake `ModelClient` over a fixed `SchemaInfo` literal (no database), and
    compare with a committed snapshot.
  - Add a snapshot of a v1 `QueryMeta` in explore and locked mode.
- **Done when:** these tests pass on the first commit of the branch, and every
  later P1–P3 commit keeps them unchanged.

### P1.1 Leaf types and source types (3 h)
- **Files:** `core/src/request/shape.ts`; new `core/src/sources/types.ts`; `core/src/connectors/types.ts`.
- **Change:**
  - Refactor `LEAF_CHECKS` (`shape.ts:20`) so its keys are an `as const` array
    `LEAF_TYPES`, and derive `type LeafType`. Behaviour is unchanged.
  - In `sources/types.ts`, define `ApiSource`, `ApiSchema`, `OperationInfo`,
    `ParamInfo`, `SourceCallOptions` (`{ timeoutMs, signal }`) and
    `CallOptions` (adds `rowCap`), as in design §3.2. Add
    `type Source = Connector | ApiSource` and `isApiSource(source)`.
  - Add `readonly kind?: 'sql'` to `Connector`.
- **Tests:** `test/request/shape.test.ts` passes unchanged.
- **Done when:** typecheck passes and nothing changes behaviour.

### P1.2 Config: `sources`, `maxSteps`, `apiTimeoutMs`, the guard (5 h)
- **Files:** `core/src/config/options.ts`, `slime-config.ts`, `validate.ts`, `defaults.ts`, `number-rules.ts`.
- **Change:**
  - **`SlimeOptions`:** gains `sources?: Record<string, Source>`; `connector`
    becomes optional in the *options*. `SlimeConfig.connector` stays a
    required `Connector`.
  - **`LimitOptions`:** gains `maxSteps` (default 4) and `apiTimeoutMs`
    (default 10 000). Add both to `LIMIT_MINIMUMS` in `number-rules.ts`:
    `maxSteps` at least 1, `apiTimeoutMs` at least 100.
  - **`SlimeConfig`** gains:
    - `sources: Readonly<Record<string, Source>>` (frozen);
    - `sqlSourceName: string`;
    - `apiSourceNames: readonly string[]`;
    - `hasApiSources: boolean`.

    `connector` returns the SQL source.
  - **`with()`:** keeps the options in `sources` form internally. Then
    `with({ connector })` replaces the SQL source instead of failing with "both
    given".
  - **`validate.ts`** gains these problems:
    - neither `connector` nor `sources` given. Keep the existing prefix
      "connector is required" (`config.test.ts:55,71`).
    - both given;
    - not exactly one SQL source;
    - a source name not matching `SOURCE_NAME = /^[a-z][A-Za-z0-9]*$/`;
    - an API source missing `describe`, `call`, `safetyCheck` or `close`, or
      whose `secrets` is not an array;
    - **the guard:** any API source → "API sources are not yet supported"
      (removed in P3.3). Mark it `// MS1, removed in P3.3`.
  - Add `sources` to `OPTION_KEYS`.
- **Tests:** `test/config/config.test.ts`: each new problem, the shorthand,
  `with({ connector })` on a `sources` config, and the guard message.
- **Done when:** existing config tests pass unchanged; `platform/runtime`
  typecheck passes.

### P1.3 Redacting source wrapper (3 h)
- **Files:** new `core/src/sources/call-source.ts`, new `core/src/sources/redact.ts`.
- **Change:**
  - `redactSecrets(text, secrets)` replaces every non-empty secret with
    `[redacted]`.
  - `callSource(sourceName, source, method, run)` runs one source method under
    a timeout and turns any error into a wrapped error. The timeout is an
    `AbortSignal.timeout(apiTimeoutMs)`, combined with a caller signal if one
    is given. The wrapped error:
    - carries a redacted message and the source name;
    - keeps `status` and `isRetryable` when the error is a `SourceError`
      (P4.2; until then, duck-typed).
  - Every call to `describe`, `safetyCheck`, `call` and `close` on any source
    goes through it (MS16).
  - The SQL source keeps its current calls in `create-slime.ts` and the engine,
    so v1 behaviour and error text stay byte-identical.
- **Tests:** `test/sources/call-source.test.ts`: the secret is removed from the
  message; a timeout aborts; status is kept.
- **Done when:** tests pass.

### P1.4 `fakeApiSource` (3 h)
- **Files:** new `core/src/testing/fake-api-source.ts`; export from `core/src/testing/index.ts`.
- **Change:** `fakeApiSource(options)` builds an `ApiSource` from
  `{ name, service, operations }`. Each operation is
  `{ params, columns, rows: Row[] | ((args) => Row[]) }`. Options:
  - per operation, `failWith?` (`{ status, message }`) and
    `gate?: Promise<void>`, a deferred promise for ordering tests, used instead
    of timers;
  - it honours `rowCap` (sets `truncated`) and `signal` (rejects with an abort
    error);
  - it records `calls`;
  - it takes `secrets` (default `['fake-secret-token']`), and every failure
    message includes the secret, so redaction tests have something to remove.
- **Tests:** `test/sources/fake-api-source.test.ts`.
- **Done when:** P1.5 and P1.6 use it.

### P1.5 Dictionary and hashes (4 h)
- **Files:** `core/src/dictionary/dictionary.ts`, new `core/src/dictionary/api-section.ts`, `core/src/request/key.ts`.
- **Change:**
  - `DictionarySources` gains `apiSchemas?`. With none, the text and hashes are
    computed exactly as today (P1.0 proves it).
  - With API schemas:
    - one section per source after the tables (design §3.4);
    - columns reuse `renderColumn`;
    - param lines are `name type [one of: …] [-- comment]`;
    - the database heading names the SQL source in quotes:
      `Database source "<sqlSourceName>": <dialect>`, and API headings are
      `API source "<name>": <service>` (P0.3 and P3.4 findings: without the
      name the model used `postgresql`; unquoted, it took the whole heading).
  - `schemaHash` without API schemas is today's. With them it is
    `sha256(canonicalJSON({ sql: schema, api: apiSchemas }))`.
  - `buildDictionary` also returns
    `sourceHashes: Record<string, string>` (one `sha256` per source).
    `HandlerProvenance` gains an optional `sourceHashes`. It is left out when
    there are no API sources, so v1 records stay byte-identical.
    `changedProvenance` ignores the field (MS17).
- **Tests:** in `test/dictionary/dictionary.test.ts`:
  - an API section snapshot matching design §3.4;
  - `schemaHash` unchanged when a fake operation's rows change;
  - `schemaHash` changed when a column is added;
  - per-source hashes.
- **Done when:** the old assertions pass untouched and the new ones pass.

### P1.6 Startup over all sources (4 h)
- **Files:** `core/src/create-slime.ts`.
- **Change:**
  - The SQL source keeps today's calls and error text.
  - API sources:
    - run `safetyCheck` in parallel through `callSource`;
    - then run `describe` in parallel through `callSource`;
    - throw one `SlimeConfigError` naming each failing API source, with
      redacted messages (MS8, MS16).
  - Pass `apiSchemas` to `buildDictionary`.
  - Crystal's other-schema warning (`create-slime.ts:57-64`) compares the SQL
    source's hash when `sourceHashes` is present (MS17).
  - Closing all sources is done in P2.10, together with the engine split.
- **Tests:** new `test/engine/startup.test.ts`. Use a test-only bypass of the
  P1.2 guard: an internal `allowApiSources` flag on the config, not exported
  from the package. Cases:
  - a `fakeApiSource` and `fakeConnector` start;
  - a failing `safetyCheck` names the source, and the error text has no secret;
  - a connector-only start produces exactly today's error text on failure.
- **Done when:** tests pass; P1.0 pins unchanged.

## 4. Phase P2: handler v2 and execution (5 d)

### P2.1 v1 handler fixtures, first (1 h)
- **Files:** new `core/test/fixtures/v1-handlers/plans-accounts.json` and `top-accounts.json`; new `core/test/compat/v1-handlers.test.ts`.
- **Change:**
  - Build the two `HandlerRecord`s by hand from
    `examples/express/offline-handlers.json`, before any P2 code, with no
    database run.
  - The test loads them into a `memoryStore` and serves them in locked mode
    with `fakeConnector`.
- **Done when:** the test passes on the first P2 commit and on every later one.

### P2.2 v2 types and schema (3 h)
- **Files:** `core/src/models/types.ts`, `core/src/models/schemas.ts`.
- **Change:**
  - **Types:**
    - `SqlStep { name; source; sql; params }`;
    - `ApiArg { param; input: string | null; value: string | number | boolean | null }`;
    - `ApiStep { name; source; operation; args: ApiArg[] }`;
    - `ArtifactV2 { version: 2; unsatisfiable; steps; shapeJs; assumptions }`;
    - `AnyArtifact = Artifact | ArtifactV2`.
  - **Guards:** `isArtifactV2(a)` (`'version' in a && a.version === 2`) and
    `isApiStep(s)`.
  - **Schema:** move the P0.3 `ArtifactV2Schema` into `schemas.ts`, with every
    object strict.
- **Tests:** new `test/models/schemas.test.ts`: valid and invalid v2
  artifacts, including both `input` and `value` set (the schema allows it;
  lint refuses it).
- **Done when:** typecheck passes; nothing reads the new types yet.

### P2.3 Widen `HandlerRecord.artifact` (5 h)
- **Files:** every place that reads `artifact.sql` or builds artifacts:
  - `core/src/engine/types.ts` (`HandlerRecord`);
  - `execute.ts:30-35`;
  - `generate.ts:35-38, 61-81` (`PreviousAttempt`);
  - `events.ts:22-31`;
  - `slime-engine.ts:117, 159`;
  - `review-loop.ts:31, 37, 53`;
  - `models/prompts.ts:79-99`;
  - `models/types.ts:28, 40, 60` (`GenerationRequest.previous`,
    `ReviewRequest.artifact`);
  - `crystallize/crystallize.ts:112`;
  - `crystallize/equivalence.ts:49-51`;
  - `testing/fakes.ts:44`;
  - `test/engine/promotion.test.ts:79`;
  - `models/offline/offline-generator.ts` (`OfflineHandlers` becomes
    `Record<string, AnyArtifact>`).
- **Change:** set `HandlerRecord.artifact: AnyArtifact`. Each reader either
  narrows with `isArtifactV2` and throws `INVALID_HANDLER` for v2 where v2
  can't occur yet, or handles both. Leave `// MS3` at the narrowing points.
  `GenerationRequest` gains an optional `format?: 'v1' | 'v2'`, default `'v1'`.
  The engine sets it on `GenerationDeps`, not in callers, so `claude.test.ts`
  and `groq.test.ts` literals keep compiling.
- **Done when:** typecheck passes; all tests pass unchanged; P1.0 pins unchanged.

### P2.4 Error codes and value-free repair messages (4 h)
- **Files:** `core/src/shared/errors.ts`, `core/src/engine/generate.ts`, `core/src/request/shape.ts`, new `core/src/engine/repair-message.ts`.
- **Change:**
  - Add `SOURCE_ERROR: 502` and `QUERY_TOO_LARGE: 422` to `STATUS_BY_CODE`.
    Add `SOURCE_ERROR` to `FINAL_CODES`; `QUERY_TOO_LARGE` stays repairable
    (MS6, MS7).
  - `validateData` (`shape.ts`) also returns structured mismatches:
    `{ path, expected, actualType }`. The existing message text stays as is
    for v1.
  - `repairMessage(error, format)`:
    - `'v1'`: returns today's `${code}: ${message}` (byte-identical).
    - `'v2'`: returns the code plus structured paths and types for
      `SHAPE_MISMATCH`, the error name only for `SANDBOX_ERROR`, and the code
      plus step name for the others. Never values (MS15).
  - `generateHandler` builds `previous.error` with it.
- **Tests:** new `test/engine/repair-message.test.ts`: v1 unchanged; v2 has no
  row value for a seeded mismatch.
- **Done when:** tests pass; P1.0 pins unchanged.

### P2.5 Step lint (5 h)
- **Files:** new `core/src/engine/checks/steps.ts`; `core/src/engine/checks/sql.ts` (export the per-SQL checks taking `{ sql, params, shapeJs }`).
- **Change:** `lintSteps(artifact, context)`. The context is
  `{ sqlSourceName, apiSchemas, inputNames, maxSteps }`. Each rule throws
  `INVALID_HANDLER` with one sentence:
  - steps count between 1 and `maxSteps`;
  - unique identifier names (`STEP_NAME = /^[a-z][A-Za-z0-9]*$/`);
  - the source exists and is of the right kind;
  - the operation exists;
  - every `args` entry names a declared param, at most once;
  - exactly one of `input` and `value` per entry;
  - `input` names an input key;
  - a constant matches the param's type and `values`;
  - no input string value equals a constant;
  - `shapeJs` is present when there is more than one step;
  - each SQL step passes `assertReadOnlySql`, placeholder mapping and the
    hard-coded check.

  `lintSteps` is pure and needs no input values, so P2.9 can run it on load.
- **Tests:** new `test/engine/checks/steps.test.ts`: one passing artifact and
  one failing case per rule.
- **Done when:** every rule has a test.

### P2.6 Sandbox: step data and the API row check (2 h)
- **Files:** `core/src/sandbox/types.ts`, `core/src/sandbox/quickjs/quickjs-runner.ts`, new `core/src/sources/plain-rows.ts`.
- **Change:**
  - Widen `ShapeJob.rows` to `ShapeInput = Row[] | Record<string, Row[]>`. The
    program text is unchanged (`shape(<first>, <input>)`), so there is no
    second code path.
  - Catch a `TypeError` from `JSON.stringify` in `toProgram` and turn it into
    `SANDBOX_ERROR`. Today it surfaces as a repairable `QUERY_ERROR` through
    `asSlimeError`; keep that code for v1 by rethrowing as before when the
    input is an array.
  - `assertPlainRows(rows, stepName)` rejects bigint, function, symbol and
    undefined. It is called only on API step rows (S4); SQL rows keep today's
    handling, including `Date`.
- **Tests:** in `test/sandbox/quickjs.test.ts`:
  - v2 `shape(data, input)` joins two step lists;
  - existing isolation tests unchanged.

  In `test/sources/plain-rows.test.ts`:
  - a bigint is refused;
  - a `Date` in a SQL row still runs.
- **Done when:** tests pass.

### P2.7 Step executor (8 h)
- **Files:** new `core/src/engine/execute-steps.ts`, new `core/src/engine/step-args.ts`; `core/src/engine/execute.ts` (dispatch).
- **Change:**
  - `executeArtifact` keeps the v1 path untouched. A v2 artifact goes to
    `executeSteps(deps, job)`, whose deps gain `sources` and `apiSchemas`.
  - `resolveArgs(step, operation, input)` runs on every run, not only the
    first. It maps each arg to its input value or constant and checks the type
    against the param:
    - `string`, `date` and `datetime` accept a string;
    - `integer` and `number` accept a number (an integer for `integer`);
    - `boolean` accepts a boolean;
    - null always passes (R5).

    A mismatch or a list is `INVALID_REQUEST`.
  - `executeSteps`:
    1. Create one `AbortController`. The deadline signal is
       `AbortSignal.any([controller.signal, AbortSignal.timeout(deadlineMs)])`,
       where `deadlineMs` is the larger of `statementTimeoutMs` and
       `apiTimeoutMs`.
    2. Start every step:
       - a SQL step calls `connector.run(...)` as today;
       - an API step calls `callSource(name, source, 'call', …)` with
         `{ timeoutMs: apiTimeoutMs, rowCap, signal }`.

       Wrap each step promise in
       `.catch((error) => { controller.abort(); throw error; })`, so any
       failure aborts the API steps.
    3. Race `Promise.all(steps)` against the deadline signal. When steps fail,
       report the first failure that is not an `AbortError`.
       - A SQL failure keeps today's classification (`QUERY_ERROR`,
         repairable).
       - An API failure becomes `SOURCE_ERROR` per MS7. `status` comes from
         the wrapped error; 429, 5xx and timeouts are retryable. Details carry
         `source`, `operation`, `status` and `attempts`.

       A running SQL step is not cancelled; its result is discarded.
    4. Call `assertPlainRows` on API rows.
    5. If more than one step ran and any result is `truncated`, throw
       `QUERY_TOO_LARGE` with `details.step` (MS6).
    6. Build `data = { [step.name]: rows }`. With `shapeJs`, run the sandbox;
       without it (one step), pass the rows through.
    7. Call `assertValidOutput`.
    8. Return an `Execution` whose `runMs` is the steps' wall time, plus
       `steps: StepTiming[]`.
- **Tests:** new `test/engine/execute-steps.test.ts` with `fakeApiSource` and
  `fakeConnector`. Cases:
  - combined output;
  - both steps start before either finishes (proved with `gate` promises, not
    timers);
  - an API failure gives `SOURCE_ERROR`; no secret appears in the message or
    `toJSON()`; the other API step sees `signal.aborted`;
  - a SQL failure gives `QUERY_ERROR` and aborts the API step;
  - a 400 is not retryable and a 503 is;
  - a wrong-typed input gives `INVALID_REQUEST` on a later run;
  - truncation in a two-step handler gives `QUERY_TOO_LARGE`;
  - `maxSteps + 1` steps are refused by lint;
  - a single step without `shapeJs` returns rows.
- **Done when:** tests pass.

### P2.8 Generation, normalization and meta (6 h)
- **Files:** `core/src/engine/generate.ts`, new `core/src/engine/normalize-artifact.ts`, `core/src/engine/meta.ts`, `core/src/engine/events.ts`, `core/src/engine/types.ts` (`QueryMeta`, `StepTiming`), `core/src/config/options.ts` (`GeneratedEvent`).
- **Change:**
  - `GenerationDeps` gains `sources`, `apiSchemas`, `format`.
  - Right after `assertSatisfiable`, call `normalizeArtifact(artifact)`. A v2
    artifact whose only step is SQL becomes v1 with:
    - `sql` and `params` from the step;
    - `shapeJs: null` if it was null;
    - otherwise `shapeJs` set to
      `function shape(rows, input) {\n<model shapeJs>\nreturn shape({ <step>: rows }, input);\n}`.
      The inner declaration shadows the outer one; there is no parsing and no
      rename.

    Normalization runs before `tryArtifact`, so the stored code is the code
    that ran (MS3).
  - `tryArtifact` for v2:
    1. `lintSteps`;
    2. `connector.check` per SQL step, with today's cost limit;
    3. `executeSteps`.
  - **Meta:**
    - `QueryMeta.steps?: StepTiming[]`, explore mode only (R9).
      `StepTiming` is a named interface:
      `{ name, source, rows, ms, sql?, operation?, args? }`.
    - For v2, `meta.sql` holds the SQL steps joined with
      `\n-- step <name>\n`.
    - `GeneratedEvent` gains `steps?`; its `sql` stays a string, the joined
      SQL (`events.ts`).
- **Tests:** in `test/engine/engine.test.ts`:
  - v2 meta in explore mode has `steps`;
  - locked mode has none.

  New `test/engine/normalize-artifact.test.ts`:
  - the normalized code gives the same result as the v2 form in the sandbox;
  - `checkShapeSource` (the Crystal allowlist) accepts it.
- **Done when:** tests pass.

### P2.9 Saved-handler lint on load (4 h)
- **Files:** `core/src/engine/handler-cache.ts`, `core/src/create-slime.ts`.
- **Change:**
  - `HandlerCache.#isUsable` (`handler-cache.ts:72-75`) also runs `lintSteps`
    for a v2 record against the current sources and schemas (MS14).
  - In explore mode a failing record is treated as stale, so it regenerates.
  - In locked mode the request gets `HANDLER_NOT_FOUND` with the lint reason
    in its message.
  - At startup in locked mode, `createSlime` lints every saved v2 record and
    emits one `warning` event listing the failing handler keys and reasons.
- **Tests:** in a new `test/engine/saved-v2.test.ts`:
  - a record naming a removed source is refused in locked mode;
  - a record using a renamed `fakeApiSource` param is refused;
  - explore mode regenerates it;
  - startup lists both.
- **Done when:** tests pass.

### P2.10 Engine wiring and split (5 h)
- **Files:** `core/src/engine/slime-engine.ts` (179 lines today), new `core/src/engine/answer.ts` (or similar), `core/src/crystallize/crystallize.ts`.
- **Change:**
  - **Engine wiring:**
    - pass `sources`, `apiSchemas` and `format` into generation and saved
      runs;
    - `close()` closes the SQL source as today, then each API source through
      `callSource`, with `Promise.allSettled`.
  - **Engine split:** extract the answer assembly (`#answer`,
    `#answerFromCrystal`, meta building) into `answer.ts`, so `slime-engine.ts`
    stays under 200 lines.
  - **Crystal:** `crystallize` skips any v2 record (by MS3 every stored v2
    record has an API step). Add a `'skipped'` value to `CrystalOutcome`
    (`crystallize.ts:36`) with the reason "has API steps" (MS9).
- **Tests:** new `test/engine/multi-source.test.ts`. It uses the P1.6 guard
  bypass, `memoryStore`, `fakeApiSource`, `fakeConnector` and `stubGenerator`
  (`testing/fakes.ts`, which counts calls). Cases:
  - a combined query returns the expected output;
  - 3 runs promote to liquid with no reviewer, and after an approving stub
    review when one is set;
  - locked mode serves the saved v2 handler;
  - a source failure is final: the generator is called once;
  - `QUERY_TOO_LARGE` during generation triggers a repair: the generator is
    called twice;
  - a single-SQL-step v2 artifact is stored as v1 and crystallizes (S3);
  - a v2 record is skipped by crystallize.

  One case runs against the demo Postgres through `test/support/database.ts`.
  That helper skips when Postgres is unreachable and fails with `REQUIRE_DB=1`,
  as the connector tests do.
- **Done when:** tests pass; `slime-engine.ts` is under 200 lines.

## 5. Phase P3: models (2 d)

### P3.1 Multi-source prompts in their own file (5 h)
- **Files:** new `core/src/models/prompts-multi-source.ts`; `core/src/models/prompts.ts` (only the shared message builders, if needed).
- **Change:**
  - Add `MULTI_SOURCE_GENERATION_INSTRUCTIONS`,
    `MULTI_SOURCE_ARTIFACT_JSON_FORMAT` and
    `MULTI_SOURCE_REVIEW_INSTRUCTIONS`, starting from the P0.3 draft. They
    cover:
    - steps;
    - `args` entries;
    - `shape(data, input)`;
    - joining on columns whose comment says `matches …`;
    - "use one SQL step if the database alone answers";
    - "a previous handler may be in v1 form; reply in v2".
  - Add `multiSourceReviewMessage`, which renders each step as SQL or as
    `operation(args)`.
  - Do not edit the existing constants or `reviewMessage`. P1.0 pins them.
- **Tests:** extend `test/models/prompt-hash.test.ts`: the v1 hashes are
  unchanged; the multi-source hashes differ.
- **Done when:** tests pass; the P1.0 snapshots are unchanged.

### P3.2 Roles pick the format (4 h)
- **Files:** `core/src/models/roles.ts`, `core/src/models/types.ts`.
- **Change:**
  - `Generator` gains an optional `readonly multiSourcePromptHash?: string`. An
    optional field was chosen over a `promptHashFor()` method so existing
    custom generators keep compiling.
  - `generatorFor` computes it from the multi-source parts.
  - `generate()` picks the instructions, JSON format and schema by
    `request.format`.
  - The reviewer picks its instructions and message by
    `isArtifactV2(request.artifact)`.
- **Tests:** in `test/models/groq.test.ts` and `claude.test.ts`, with their
  existing stubs: a v2 request sends the multi-source instructions and the v2
  schema, and parses a v2 reply.
- **Done when:** tests pass.

### P3.3 Provenance, fakes and removing the guard (3 h)
- **Files:** `core/src/create-slime.ts`, `core/src/config/validate.ts`, `core/src/testing/fakes.ts`, `core/src/models/offline/offline-generator.ts`.
- **Change:**
  - `currentProvenance` uses `generator.multiSourcePromptHash` when
    `config.hasApiSources`.
  - Validation: API sources plus a generator without `multiSourcePromptHash`
    is a config problem.
  - Remove the P1.2 "not yet supported" guard and the test-only bypass.
  - Set `multiSourcePromptHash` on the offline generator, `stubGenerator` and
    `fakeGenerator`, in the same commit.
- **Tests:** config tests for the new problem; P1.0 pins unchanged; all P2 tests
  pass without the bypass.
- **Done when:** a config with an API source starts with a real generator.

### P3.4 Manual live generation (2 h)
- **Files:** `core/bench/spikes/multi-source-live.mjs` (outside the `npm test` glob).
- **Change:** run a real Groq or Claude generator on the demo database plus a
  `fakeApiSource` shaped like Notion `feedback`. Ask demo intent 1 and print
  the handler and result.
- **Done when:** one valid two-step run, pasted into the P3 pull request.

## 6. Phase P4: generic API source (3 d)

### P4.1 Deadline retry helper (2 h)
- **Files:** new `core/src/sources/api/retry.ts`. `groq-client.ts` is **not** changed.
- **Change:** `fetchWithDeadline(request: DeadlineFetch): Promise<FetchOutcome>`.
  - It takes `url`, `init`, `deadlineSignal`, `maxRetryWaitMs` and
    `fetchImpl?`.
  - `fetchImpl` defaults to `globalThis.fetch`, read at call time so tests can
    swap it.
  - One deadline covers all attempts. A 429 is retried after `Retry-After`
    while the deadline allows.
  - It returns `{ response, attempts }`.
- **Tests:** new `test/sources/retry.test.ts`: deadline, abort, a 429 then 200,
  a 429 past the deadline.
- **Done when:** tests pass; `groq.test.ts` is untouched and passes.

### P4.2 `SourceError` (1 h)
- **Files:** new `core/src/sources/source-error.ts`; export from `core/src/index.ts`; `core/test/package.test.ts` (it checks runtime export names).
- **Change:** `class SourceError extends Error { status: number | null; isRetryable: boolean; attempts: number }`.
  Its message never holds headers or response bodies.
- **Tests:** `package.test.ts` lists the new export.

### P4.3 Constrained client: URL and transport rules (4 h)
- **Files:** new `core/src/sources/api/http-client.ts`, new `core/src/sources/api/safe-url.ts`.
- **Change:**
  - `createHttpClient(options: HttpClientOptions): HttpClient`, with named
    interfaces `HttpClient` and `HttpRequestOptions`. Options are
    `{ baseUrl, headers?, secrets, fetchImpl?, deadlineSignal }`. The client
    offers `getJson(path, options)` and `request(options)` for method, path,
    query and body.
  - **`buildUrl(baseUrl, path, query)`:**
    - the path must start with exactly one `/` and contain no `//` or `..`;
    - the path is appended to `baseUrl`'s pathname, keeping its prefix;
    - query values go through `URLSearchParams`, with null and undefined
      dropped;
    - the result's origin must equal `baseUrl`'s origin, otherwise a
      `SourceError` (MS10).
  - Every header value is added to the redaction secrets (MS16).
  - Errors are `SourceError`s with redacted messages.
- **Tests:** new `test/sources/safe-url.test.ts` and `http-client.test.ts`:
  - query values with `../`, `?`, `#` and a full URL are encoded and keep the
    host;
  - the paths `//evil.example/x`, `/a/../b` and `a` are refused;
  - a `baseUrl` with a path prefix keeps it;
  - a 500 body containing the token yields a message without it.
- **Done when:** the S1 and S2 tests pass.

### P4.4 Constrained client: redirects and size cap (3 h)
- **Files:** `core/src/sources/api/http-client.ts`, new `core/src/sources/api/read-capped.ts`.
- **Change:**
  - **Redirects:** use `redirect: 'manual'`. Node's undici returns the real
    3xx status with a `Location` header. Follow at most 3 same-origin
    redirects, and refuse any cross-origin one with a `SourceError`.
  - **Size cap:** read the body with a counting stream reader, and cancel the
    stream past `MAX_RESPONSE_BYTES` (10 MB). `Content-Length` is missing for
    chunked or gzip responses, so it can't be relied on.
  - **Parsing:** parse JSON from the capped text.
- **Tests:**
  - a same-origin 301 is followed;
  - a 302 to another origin fails;
  - a chunked body over the cap fails;
  - malformed JSON fails as a `SourceError`.
- **Done when:** tests pass.

### P4.5 `defineApiSource` (4 h)
- **Files:** new `core/src/sources/api/define-api-source.ts`; export from `core/src/index.ts`; `package.test.ts`.
- **Change:** `defineApiSource(declaration)`. The declaration is
  `{ service, baseUrl, headers?, secrets?, operations, check? }`.
  - **At definition time:** validate param and column types against
    `LEAF_TYPES`, and throw `SlimeConfigError` with every problem.
  - **`describe()`:** return operations in declaration order. Columns are not
    null unless the type ends with `|null`; comments are carried through.
  - **`call()`:**
    1. check the operation and args; unknown ones are a `SourceError` with
       status 400 and not retryable;
    2. build an `http` client for this call from its `signal` and `timeoutMs`;
    3. run `run(args, { http, signal })`;
    4. cut rows at `rowCap`, setting `truncated`, and measure `ms`.
  - **`safetyCheck()`:** run the optional `check`, or return
    `{ ok: true, user: service, problems: [] }`.
  - **`secrets`:** the declaration's list plus every header value.
- **Tests:** new `test/sources/define-api-source.test.ts`: declaration
  validation, unknown operations, `rowCap`, describe order.
- **Done when:** tests pass.

### P4.6 Fixture `fetch` (2 h)
- **Files:** new `core/src/testing/fixture-fetch.ts`, exported from `./testing`.
- **Change:**
  - `fixtureFetch(dir)` returns a `fetch` implementation. Its key is the
    origin, method, path and sorted query, plus `sha256(canonicalJSON(body))`
    for POST.
  - It reads `<dir>/<slug>.json`, which holds `{ status, headers, body }`.
  - It throws on any unrecorded key (S10).
- **Tests:** new `test/testing/fixture-fetch.test.ts`: a hit, a miss, an unknown
  method, two bodies that differ only in key order map to one key.
- **Done when:** tests pass.

### P4.7 `describeApiSourceContract` (3 h)
- **Files:** new `core/src/testing/api-source-contract.ts`, named like `describeConnectorContract` in `connector-contract.ts`.
- **Change:** a `node:test` suite factory `describeApiSourceContract(options)`.
  Its options are `makeSource` and `cases`: one operation, valid args, all-null
  args and an expected row count. It asserts that:
  - `describe` is valid and identical on two calls;
  - rows match the declared types, with nulls only where nullable;
  - all-null args return at least as many rows as filtered ones;
  - `rowCap: 1` sets `truncated`;
  - an aborted signal rejects;
  - unknown operations and args are rejected;
  - errors contain none of `source.secrets`.
- **Tests:** run it against `fakeApiSource`.
- **Done when:** the contract passes for the fake.

### P4.8 Ghibli source in the example (3 h)
- **Files:**
  - new `examples/multi-source/package.json` (dependencies:
    `@slime-cloud/core` as `file:../../core`, `hono`, `@hono/node-server`,
    `pg`) and `package-lock.json`;
  - `src/films.mjs`;
  - `test/films.test.mjs`;
  - `test/fixtures/ghibli/*.json`.
- **Change:**
  - `films.mjs` is design §4.1's `ghibliFilms`, plus a `check` that GETs
    `/films?limit=1`.
  - The fixtures are hand-curated: 4 films, two directors, public data.
  - The test runs `describeApiSourceContract` with `fixtureFetch`.
- **Done when:** `npm test` in `examples/multi-source` passes offline.

## 7. Phase P5: Notion (3.5 d)

Before coding, confirm these against Notion's documentation, and note each
answer in the P5 pull request:
- the pinned version header;
- the data source retrieve and query response shapes;
- whether properties carry a `description` (Q13);
- whether an integration's capabilities can be read through the API;
- how to create a database with an initial data source;
- whether `status` properties can be created through the API.

### P5.0 Manual workspace setup (2 h)
- **Files:** `examples/multi-source/README.md` (a setup section).
- **Change:**
  1. Create a Notion workspace page.
  2. Create two integrations: "Slime reader" with "Read content" only, and
     "Slime seeder" with insert content.
  3. Share the parent page with both.
  4. Write each step down in the README.
- **Done when:** a second person can repeat it from the README.

### P5.1 Package entry (1 h)
- **Files:** new `core/src/sources/notion/index.ts`; `core/package.json` (export `"./notion"`); `core/test/package.test.ts`.
- **Change:** export `notionSource` and its option types.
- **Done when:** the package test passes.

### P5.2 Schema mapping, names and sanitizing (5 h)
- **Files:** new `core/src/sources/notion/notion-schema.ts`, new `core/src/sources/notion/column-names.ts`, new `core/src/sources/notion/sanitize.ts`.
- **Change:**
  - **`operationFromDataSource(alias, dataSource, options)`:** maps a data
    source to `OperationInfo` per design §4.2.
    - Every column is nullable, plus `id string not null` as the primary key.
    - The options are `exclude`, `comments` and `useNotionDescriptions`.
  - **`columnName(propertyName, taken)`:**
    1. NFKD, strip non-ASCII, camelCase;
    2. empty → `property<N>`;
    3. a leading digit → a `p` prefix;
    4. `id` is reserved;
    5. a collision gets a numeric suffix, in Notion's property order.
  - **Generated params:**
    - equality on select, status and checkbox;
    - `<column>From` / `<column>To` on date and created_time.
  - **`sanitizeMetadata(text)`:** a single line, no control characters, at most
    200 characters. Applied to property names before naming, to option labels,
    to descriptions and to the data source title (MS12).
- **Tests:** new `test/sources/notion/notion-schema.test.ts`:
  - every property type in the table;
  - excluded types absent;
  - each naming edge case;
  - `exclude`, `comments` and `useNotionDescriptions`;
  - a newline and a 500-character label sanitized.
- **Done when:** tests pass.

### P5.3 Filters and rows (3 h)
- **Files:** new `core/src/sources/notion/notion-filter.ts`, `notion-rows.ts`.
- **Change:**
  - `filterFromArgs(operation, args)` returns a Notion `{ and: [...] }`, or no
    filter when every arg is null.
  - `rowFromPage(operation, page)` normalizes:
    - rich text to plain text;
    - dates to `YYYY-MM-DD`, or full ISO when a time is present;
    - multi_select joined with `", "`;
    - empty cells to `null`.
- **Tests:** unit tests per param kind and per property type.

### P5.4 `notionSource` on hand-written fixtures (5 h)
- **Files:** new `core/src/sources/notion/notion-source.ts`, new `core/src/sources/notion/limit-concurrency.ts`, `core/test/fixtures/notion-handwritten/*.json`.
- **Change:** `notionSource(options)`. The options are `token`,
  `notionVersion`, `dataSources`, and optionally `exclude`, `comments`,
  `useNotionDescriptions` and `fetchImpl`.
  - **Connection:** base URL `https://api.notion.com`; headers
    `Authorization: Bearer` and `Notion-Version`. They go through the
    constrained client, so the token is a secret automatically.
  - **Concurrency:** at most 2 requests in flight per source (MS12).
  - **`describe()`:** `GET /v1/data_sources/{id}` per alias, then
    `operationFromDataSource`.
  - **`call()`:**
    - `POST /v1/data_sources/{id}/query` with `filter` and `page_size: 100`;
    - follow `next_cursor` while `has_more` and fewer than `rowCap` rows were
      read;
    - set `truncated` when `rowCap` rows were read and `has_more` is still
      true, or on `request_status.type === 'incomplete'`.
  - **`safetyCheck()`:** one call, `GET /v1/users/me`; `user` is the bot name.
    Startup costs N+1 calls.
- **Tests:** new `test/sources/notion/notion-source.test.ts`, over hand-written
  fixtures:
  - `describeApiSourceContract`;
  - pagination stops at `rowCap`;
  - a 429 then 200 succeeds within `apiTimeoutMs`;
  - no more than 2 requests in flight.
- **Done when:** the contract passes over the hand-written fixtures.

### P5.5 Seed script, recorder and recorded fixtures (5 h)
- **Files:**
  - new `examples/multi-source/scripts/seed-notion.mjs`;
  - new `core/scripts/record-notion-fixtures.mjs`;
  - new `core/test/fixtures/notion/*.json`;
  - a copy for the example in `examples/multi-source/test/fixtures/notion/`,
    because the example can't read `core/test/` from the packed tarball.
- **Change:**
  - **Seed script.** It reads `NOTION_SEED_TOKEN`, `NOTION_PARENT_PAGE_ID` and
    `DATABASE_URL`. It creates "Customer feedback" and "Movie nights" with the
    design §4.2 properties (Status falls back to select if needed), adds about
    40 and 15 pages, and prints the data source ids.
    - Account names come from
      `SELECT name FROM accounts ORDER BY id LIMIT 20`.
    - Sentiment and status are spread so that intent 1 has non-zero counts.
    - Films come from the Ghibli fixture titles.
  - **Recorder.** It runs a scenario with the reader token: `users/me`, both
    retrieves, and exactly the queries that demo intents 1 and 2 send. It
    scrubs by allowlist, per endpoint: it keeps only the fields
    `notion-schema.ts` and `notion-rows.ts` read, and drops `created_by`,
    `people` objects and the bot's owner. It maps every real id (data source,
    page, cursor) to a stable placeholder UUID in requests and responses alike,
    then computes the fixture keys.
- **Done when:**
  - a fresh workspace is seeded with one command;
  - the P5.4 tests also pass over the recorded fixtures;
  - the fixture diff contains no token, real id or personal data (reviewed in
    the pull request).

### P5.6 Security tests S6 and S8 (3 h)
- **Files:** `core/test/sources/notion/notion-source.test.ts`, `core/test/engine/multi-source.test.ts`.
- **Change:**
  - **S6:** the dictionary snapshot for the recorded schema contains no
    `people` column and no `exclude`d property.
  - **S8:** a spy generator records every prompt. Its first reply is a v2
    handler whose `shape` returns a wrong type, which forces a repair; its
    second reply is correct. Run demo intent 1 over the recorded Notion
    fixtures and assert that no seeded page title or account note appears in
    any prompt, including the repair message.
- **Done when:** tests pass.

## 8. Phase P6: example, tests, docs (2.5 d)

### P6.1 Example app (4 h)
- **Files:** `examples/multi-source/src/server.mjs`, `src/config.mjs`, `offline-handlers.json`, `.env.example`, `.gitignore`, `README.md`.
- **Change:**
  - **`server.mjs`:** the Hono server from `examples/hono`, with `GET /health`
    and `POST /slime`.
  - **`config.mjs`:**
    - `sources`: `db` from `DATABASE_URL` (default: the demo database),
      `notion` from `NOTION_TOKEN`, `NOTION_FEEDBACK_ID` and
      `NOTION_MOVIE_NIGHTS_ID`, and `films` from `src/films.mjs`;
    - `comments`: `{ feedback: { account: 'matches db.accounts.name' }, movieNights: { film: 'matches title in films operation films.list' } }`;
    - the generator: Groq if `GROQ_API_KEY`, else Claude, else the offline
      generator over `offline-handlers.json`;
    - `FETCH_FIXTURES=1` swaps in `fixtureFetch` over the example's fixtures.
  - **`offline-handlers.json`:** v2 artifacts for the three demo intents whose
    API requests match the recorded fixtures exactly.
  - **README:** setup (P5.0), seeding, and the S7 warning (explore mode only
    in development).
- **Done when:** `npm start` with `FETCH_FIXTURES=1` and the offline generator
  answers the three intents.

### P6.2 Example smoke test (2 h)
- **Files:** `examples/multi-source/test/app.test.mjs`.
- **Change:** start the app in-process with `FETCH_FIXTURES=1` and the offline
  generator. `POST /slime` each demo intent, and assert the output shape and
  non-empty data (T7).
- **Done when:** the test passes against the demo database.

### P6.3 CI job (2 h)
- **Files:** `.github/workflows/ci.yml`.
- **Change:** a job `example-multi-source`, copied from the existing `example`
  job:
  - the same Postgres service, `init.sql` and packed tarball;
  - `working-directory: examples/multi-source`;
  - `cache-dependency-path: examples/multi-source/package-lock.json`.
- **Done when:** the job is green on the P6 pull request.

### P6.4 Engine tests over recorded fixtures (3 h)
- **Files:** new `core/test/engine/multi-source-fixtures.test.ts`.
- **Change:** the T4 cases from design §7 that need the real adapters:
  - the combined query over the Notion and Ghibli fixtures;
  - a Notion schema fixture with one added property changes `schemaHash`, and
    explore mode regenerates;
  - a fixture with a renamed property makes locked mode refuse the saved
    handler (MS14);
  - a fixture returning 503 gives a retryable `SOURCE_ERROR`.
- **Done when:** tests pass in CI.

### P6.5 Live run (3 h)
- **Files:** `examples/multi-source/scripts/live-run.mjs`.
- **Change:** run the three intents against seeded Notion, the Ghibli API and a
  real model. Repeat each `gasToLiquidRuns` times and confirm promotion. No
  bench cases: the bench harness compares only reference SQL.
- **Done when:** results (output, steps, promotion) are pasted into the P6 pull
  request.

### P6.6 Documentation (3 h)
- **Files:**
  - `core/docs/request-format.md`: confirm the P0.2 section matches the code.
  - `core/README.md`: sources, `defineApiSource`, `@slime-cloud/core/notion`.
  - `README.md`: add `examples/multi-source/` to the map.
  - `docs/README.md`.
  - `core/docs/multi-source.md`: Status → Current for what shipped.
  - `core/PLAN.md`: a milestone row "M8 multi-source".
- **Done when:** a reader can set up the example from the README alone.

## 9. Effort

| Phase | Steps (h) | Days | Main reasons |
|---|---|---|---|
| P0 | 10 | 1.5 | Spike through both real clients |
| P1 | 24 | 2.5 | Pins first, config ripple, redacting wrapper, startup |
| P2 | 43 | 5 | Record widening, executor semantics, normalization, saved-handler lint, engine split |
| P3 | 14 | 2 | Structured-output schema, separate prompt file, guard removal |
| P4 | 22 | 3 | URL rules, streaming cap, redirects, contract suite |
| P5 | 24 | 3.5 | Notion unknowns, manual workspace, recorder with allowlist scrubbing |
| P6 | 17 | 2.5 | Fixture coupling, CI job, live run |
| **Total** | **154** | **about 20 (18–22)** | |

Days include review rounds and CI fixes, so they exceed hours ÷ 8.

## 10. Order and dependencies

| Phase | Needs | Can run alongside |
|---|---|---|
| P0 | — | — |
| P1 | P0 | — |
| P2 | P1 | P4.1–P4.4 |
| P3 | P2 | P4, P5 |
| P4 | P1 (types) | P2, P3 |
| P5 | P1, P4 | P3 |
| P6 | P2, P3, P4, P5 | — |

The critical path is P0 → P1 → P2 → P3 → P6. A second developer takes P4, then
P5.

## 11. Out of scope

- S5 in `platform/runtime` (load only the secrets the runtime needs). Track it
  as its own issue.
- Everything under design §10 "Later (P7)".

## 12. Changes in revision 2

| Finding | Source | Change |
|---|---|---|
| Normalized handler can't be crystallized; stored code never ran | both | Nested `shape` with no rename, before the first run (P2.8); acorn rename dropped |
| Zero SQL sources breaks `connector` and the runtime | both | Exactly one SQL source (MS1, P1.2) |
| Locked mode serves v2 handlers with changed sources | architect | `version: 2`; saved-handler lint on load and at startup (MS14, P2.9) |
| S8 claim false; test can't catch it | architect | Value-free v2 repair messages (MS15, P2.4); forced-repair S8 test (P5.6) |
| `args` map rejected by Claude structured output | staff | `args` as a list (MS4); spike through real clients (P0.3) |
| 2 s timeout too small; no startup timeout | both | `apiTimeoutMs` (MS5); `{ timeoutMs, signal }` on `describe` and `safetyCheck` |
| Notion 2N+1 startup calls; no concurrency cap | architect | `safetyCheck` is `users/me` only; 2 in flight (P5.4) |
| Error classification; abort semantics; deadline | both | MS7 classification; abort on any failure; deadline race; first non-abort error (P2.7) |
| Redaction misses startup errors; opt-in secrets | architect | One `callSource` wrapper (P1.3); header values added to secrets |
| SSRF via `//host`; path prefix lost | both | Origin check and path rules (P4.3) |
| P1 merge exposes broken API sources; startup text changes | both | Config guard until P3.3; SQL error text unchanged (P1.2, P1.6) |
| Fixtures can leak data; scrubbing breaks keys | both | Allowlist scrubbing, id map before hashing, hand-curated Ghibli (P4.6, P5.5) |
| Plain-JSON check breaks pg `Date` | both | Checked on API rows only (P2.6) |
| Groq retry extraction changes behaviour | both | Groq untouched; new deadline helper (P4.1) |
| Hidden `artifact.sql` ripple | staff | Separate widening step with the full list (P2.3) |
| Input type checked only at generation | staff | Checked on every run (P2.7) |
| Circular P5.4 and P5.5; no workspace step | staff | Hand-written fixtures first; P5.0 setup |
| P1.7 duplicated pins and ran too late | both | P1.0 first, extending existing pins, plus `ModelCall` snapshots |
| Files over 200 lines; inline types | staff | `prompts-multi-source.ts`; engine split (P2.10); `StepTiming`, `HttpClient` |
| Global `schemaHash` flags every Crystal handler | architect | `sourceHashes` in provenance (MS17, P1.5) |
| Notion metadata injection | architect | Sanitizing; descriptions opt-in (P5.2) |
| `meta.handlerSteps` duplicates `meta.steps` | architect | Dropped; `StepTiming` carries the step details |
| Live test inside the test glob; bench harness | staff | Manual scripts under `bench/spikes` and the example (P3.4, P6.5) |
| Estimates contradicted the step hours | staff | About 20 days (§9) |
