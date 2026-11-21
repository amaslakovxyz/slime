# Multi-source handlers: step-by-step implementation plan

| | |
|---|---|
| Status | **Plan** (draft; not started) |
| Design | [multi-source.md](./multi-source.md) at commit `2c03f85` (PR #26) |
| Owner | Konstantin |
| Date | 2026-11-21 |
| Effort | 9.5–13.5 person-days for one developer, phases P0–P6 |

This plan turns §10 of the design into steps an engineer or a coding agent can
take one at a time. Each step names its files, what changes, the tests that
prove it, and when it is done. Read the design first. This plan does not repeat
why; it says what to do and where.

## 0. How to use this plan

**Rules that apply to every step.**
- Work in a worktree under `.worktrees/<branch-slug>/`, one branch per phase:
  `feat/ms-p1-sources`, `feat/ms-p2-steps`, and so on. Open one pull request
  per phase against `main` ([AGENTS.md](../../AGENTS.md)).
- Follow [core/AGENTS.md](../AGENTS.md):
  - named constants;
  - named interfaces at module boundaries;
  - files under about 150 lines;
  - comments only for *why*;
  - decision IDs as `// MS6`.
- Each phase ends green on `npm run typecheck -w @slime-cloud/core`,
  `npm test -w @slime-cloud/core`, `npm run check:pack -w @slime-cloud/core`
  and `pre-commit run --all-files`.

**Phases can merge before the demo.** Every phase keeps the compatibility rule
(design §3.3): with no API source configured, Slime is byte-identical to today.
No existing setup sees a change, so the demo risk behind Q10 does not apply.
The test `test/compat/no-api-source.test.ts` (step P1.7) guards this from P1 on.

**Step format.** Every step has the same four parts:
- **Files**: what to create or edit.
- **Change**: what to write.
- **Tests**: which tests prove it.
- **Done when**: the check that closes the step.

Effort is per step, in hours (h) or days (d).

## 1. Decisions this plan assumes

P0 records these in [core/PLAN.md](../PLAN.md) as a new decision table, "MS —
multi-source". They are the design's recommendations (§11) plus the refinements
in §2 below. If P0 changes one, update the steps that cite it.

| ID | Decision | Design ref |
|---|---|---|
| MS1 | `sources` config: a map of named sources, at most one SQL source, any number of API sources; `connector: x` means `sources: { db: x }` | §3.2, Q2 |
| MS2 | API source port and contract: flat rows of plain JSON, output-notation leaf types, nullable where declared, no list columns | §3.2, Q4 |
| MS3 | v2 artifact with `steps`, produced only when an API source is configured; a single-SQL-step v2 artifact is stored as v1 | §3.3, Q1, §2.2 below |
| MS4 | API arguments bind to an input name or a typed constant checked against `values` | §3.3, Q3 |
| MS5 | `maxSteps` (default 4) is the only new limit; each step uses `rowCap` and `statementTimeoutMs` | §3.5 |
| MS6 | A truncated step in a multi-step handler fails with `QUERY_TOO_LARGE` (422, final) | §3.5 |
| MS7 | `SOURCE_ERROR`: 502, `retryable: true`, final during generation; message redacted | §3.5, S2 |
| MS8 | Startup fails if any source fails `describe()` or `safetyCheck()` | Q6 |
| MS9 | No Crystal for handlers with an API step | §3.6, Q7 |
| MS10 | API adapters reach the network only through the constrained client | §4.1, Q8 |
| MS11 | New code lives in `core/src/sources/` | Q9 |
| MS12 | Notion: schema discovered at startup; generated equality and range params; `people`, `relation`, `files`, `formula`, `rollup` excluded | §4.2, Q5, Q11 |
| MS13 | Cross-source join hints are column comments | §3.2 |

## 2. Refinements to the design found while planning

These come from reading the code. P0 copies them into the design document.

1. **Two prompt hashes.** Today `Generator.promptHash` is computed once, when
   the generator is built (`core/src/models/roles.ts`), and `create-slime.ts`
   records it in every handler's provenance. To keep the compatibility rule,
   `Generator` gains an optional `multiSourcePromptHash`. `createSlime` uses it
   instead of `promptHash` when an API source is configured. A generator
   without it cannot serve a multi-source setup, and config validation says so.
2. **Single-SQL-step artifacts are stored as v1.** If a v2 artifact has exactly
   one step and that step is SQL, the engine converts it to a v1 artifact
   before saving:
   - `shapeJs: null` stays null.
   - Otherwise the model's `function shape(data, input)` is renamed to
     `shapeSteps` (an acorn rename, using the parser `crystallize` already
     depends on). A v1 wrapper is added:
     `function shape(rows, input) { return shapeSteps({ <stepName>: rows }, input); }`.

   Everything after saving then sees a v1 handler, unchanged: execution, meta,
   review, Crystal. This replaces the design's "crystallize single-SQL-step v2
   handlers" with something simpler.
3. **Ghibli fixtures live with the example.** The Ghibli source is app code, so
   its fixtures and contract test sit in `examples/multi-source/test/`. Notion's
   live in `core/test/fixtures/notion/`.
4. **`GeneratedEvent.sql` stays a string.** For v2 it holds the SQL steps joined
   with `\n-- step <name>\n`, and a new optional `steps` field carries the full
   list. Existing `onEvent` loggers keep working.

## 3. Phase P0: decide and spike (1 d)

### P0.1 Record decisions (2 h)
- **Files:** `core/PLAN.md`, `docs/product/concepts_brief.md`, `core/docs/multi-source.md`.
- **Change:**
  - Add the MS1–MS13 table to PLAN.md §3.
  - Set C12 to "Amended by MS1".
  - In concepts_brief.md, replace the non-goal "Connectors other than Postgres"
    with "Write connectors; non-HTTP sources (see core/docs/multi-source.md)".
  - Copy §2 of this plan into the design: §3.3 and §3.6 for refinement 2, §9
    for refinements 1 and 4.
  - Mark design §11 Q1–Q11 "Decided" with their MS ID.
- **Done when:** the PLAN.md diff is merged in the P0 pull request.

### P0.2 Write the v2 artifact and meta schema (Q12) (2 h)
- **Files:** `core/docs/request-format.md`.
- **Change:** add a section "Multi-source handlers" with:
  - The v2 artifact JSON:
    ```jsonc
    {
      "unsatisfiable": null | "<one sentence>",
      "steps": [
        { "name": "<identifier>", "source": "<source name>", "sql": "<SELECT>", "params": ["<input name>"] },
        { "name": "<identifier>", "source": "<source name>", "operation": "<operation name>",
          "args": { "<param>": { "input": "<input name>" } | { "value": <string|number|boolean> } } }
      ],
      "shapeJs": "function shape(data, input) { … }" | null,
      "assumptions": ["…"]
    }
    ```
  - `meta.steps` (explore mode only): `[{ "name": string, "source": string, "rows": integer, "ms": number }]`.
  - Two new error codes: `SOURCE_ERROR` (502, retryable) and `QUERY_TOO_LARGE` (422, not retryable).
- **Done when:** the section is reviewed in the P0 pull request. Steps P2.2 and
  P2.6 implement exactly this.

### P0.3 Prompt-only spike (4 h)
- **Files:** `core/bench/spikes/multi-source-prompt.mjs` (new; not shipped, not in CI).
- **Change:** a script that sends Groq (or Claude) three things:
  - a hand-written dictionary: the demo `db` plus the Notion `feedback` and
    Ghibli `films` operations exactly as in design §3.4;
  - draft v2 generation instructions (the text P3.1 will refine);
  - the three demo intents (design §8).

  It validates each reply against the P0.2 JSON with a throwaway zod schema and
  prints it.
- **Done when:** at least 2 of the 3 intents return a lint-plausible two-step
  artifact. The replies and the prompt draft are pasted into the P0 pull
  request. If fewer than 2 do, stop and revisit the step format before P1.

## 4. Phase P1: sources and dictionary (1–1.5 d)

### P1.1 Source types (2 h)
- **Files:** new `core/src/sources/types.ts`; edit `core/src/connectors/types.ts`.
- **Change:**
  - In `sources/types.ts`, define `ApiSource`, `ApiSchema`, `OperationInfo`,
    `ParamInfo`, `CallOptions` as in design §3.2. `ParamInfo.type` reuses the
    leaf type names from `core/src/request/shape.ts`; export a `LeafType` type
    from there if none exists.
  - Add `type Source = Connector | ApiSource` and the guard
    `isApiSource(source): source is ApiSource` (`source.kind === 'api'`).
  - In `connectors/types.ts`, add `readonly kind?: 'sql'` to `Connector`.
- **Tests:** type-only; covered by P1.3 and P1.4.
- **Done when:** typecheck passes and no existing file changes behaviour.

### P1.2 Export the types (0.5 h)
- **Files:** `core/src/index.ts`, `core/test/package.test.ts`.
- **Change:** export the P1.1 types from the main entry. Update the
  package test's export list.
- **Done when:** `package.test.ts` passes.

### P1.3 Config: `sources` and `maxSteps` (4 h)
- **Files:** `core/src/config/options.ts`, `slime-config.ts`, `validate.ts`, `defaults.ts`.
- **Change:**
  - `SlimeOptions`: `connector?: Connector` (now optional) and
    `sources?: Record<string, Source>`.
  - `LimitOptions`: `maxSteps: number`, default `4` in `defaults.ts`.
  - `SlimeConfig` gains:
    - `sources: Readonly<Record<string, Source>>` (frozen; `{ db: connector }`
      when only `connector` is given);
    - `sqlSourceName: string | undefined`;
    - `apiSourceNames: readonly string[]`;
    - `hasApiSources: boolean`.

    Keep `connector` as a getter for the SQL source, or `undefined`.
    `platform/runtime` reads it.
  - `validate.ts` adds these problems, each one sentence:
    - neither `connector` nor `sources` given;
    - both given;
    - more than one SQL source;
    - a source name not matching `SOURCE_NAME = /^[a-z][A-Za-z0-9]*$/`;
    - an API source missing `describe`, `call`, `safetyCheck` or `close`, or
      with non-array `secrets`;
    - `maxSteps` not a positive integer.

    `OPTION_KEYS` gains `sources`.
- **Tests:** `core/test/config/config.test.ts`: each new problem; `connector`
  shorthand; `with()` keeps `sources`.
- **Done when:** existing config tests pass unchanged and the new ones pass.

### P1.4 `fakeApiSource` (3 h)
- **Files:** new `core/src/testing/fake-api-source.ts`; export from `core/src/testing/index.ts`.
- **Change:** `fakeApiSource(options)` returns an `ApiSource` built from
  `{ name, service, operations: Record<string, { params, columns, rows: Row[] | ((args) => Row[]) }> }`.
  It supports:
  - `failWith?: SourceErrorLike` and `delayMs?` per operation;
  - honouring `rowCap` (sets `truncated`) and `signal` (rejects with an abort
    error);
  - a `calls` array recording each `{ operation, args }`;
  - `secrets` (default `['fake-secret-token']`).
- **Tests:** `core/test/sources/fake-api-source.test.ts`: rows, `rowCap`, abort, failure.
- **Done when:** the fake is used by P1.5 and P1.6 tests.

### P1.5 Dictionary renders API sources (4 h)
- **Files:** `core/src/dictionary/dictionary.ts`, plus a new `core/src/dictionary/api-section.ts` if the file passes 150 lines.
- **Change:**
  - `DictionarySources` gains `apiSchemas?: Readonly<Record<string, ApiSchema>>`.
  - With no API schemas, the text and hashes are computed exactly as today
    (byte-identical; no code path change).
  - With API schemas, add one section per source after the tables:
    - an `API source <name>: <service>` heading;
    - per operation, `Operation <name>: <description>`;
    - a `params (all optional; null = not given):` block;
    - a `returns rows:` block.

    Column lines reuse `renderColumn`. Param lines render
    `name type [one of: …] [-- comment]`. Operations and columns keep the
    adapter's order.
  - `schemaHash`: `sha256(canonicalJSON(schema))` without API schemas (today);
    with them, `sha256(canonicalJSON({ sql: schema, api: apiSchemas }))`.
- **Tests:** `core/test/dictionary/dictionary.test.ts` adds:
  - an API section snapshot matching design §3.4;
  - `schemaHash` unchanged when a fake operation's rows change;
  - `schemaHash` changed when a column is added.

  The existing assertions stay unchanged.
- **Done when:** the old dictionary tests pass untouched and the new ones pass.

### P1.6 Startup over all sources (3 h)
- **Files:** `core/src/create-slime.ts`, `core/src/engine/slime-engine.ts` (`close`).
- **Change:**
  - `createSlime` runs `safetyCheck()` on every source in parallel and collects
    the failures. It throws one `SlimeConfigError` that names each failing
    source (MS8).
  - It then runs `describe()` on every source and passes `apiSchemas` to
    `buildDictionary`.
  - `close()` closes every source and tolerates one failing (`Promise.allSettled`).
- **Tests:** `core/test/engine/startup.test.ts` (new):
  - a `fakeApiSource` plus a stub SQL connector start;
  - a failing `safetyCheck` names the source;
  - `close` closes all sources.
- **Done when:** tests pass; `platform/runtime` tests pass (`npm test` there).

### P1.7 Compatibility guard (2 h)
- **Files:** new `core/test/compat/no-api-source.test.ts`.
- **Change:** with only `connector`, pin these against values recorded on
  `main` today:
  - the dictionary text;
  - `schemaHash`;
  - `dictionaryHash`;
  - the Groq and Claude generators' `promptHash`.

  Record the values in the test as literals, with a one-line comment saying
  they must never change in this project.
- **Done when:** the test passes on this branch and would fail on any drift.

## 5. Phase P2: handler v2 and execution (2–3 d)

### P2.1 Error codes (1 h)
- **Files:** `core/src/shared/errors.ts`, `core/src/engine/generate.ts`.
- **Change:**
  - Add `SOURCE_ERROR: 502` and `QUERY_TOO_LARGE: 422` to `STATUS_BY_CODE`.
  - Add both to `FINAL_CODES` (MS6, MS7).
- **Tests:** `core/test/engine/checks/errors.test.ts` (or the nearest existing
  errors test): status, `toJSON`.
- **Done when:** tests pass.

### P2.2 v2 artifact types and schema (3 h)
- **Files:** `core/src/models/types.ts`, `core/src/models/schemas.ts`, `core/src/engine/types.ts`, `core/src/models/offline/offline-generator.ts`.
- **Change:**
  - Add these types: `SqlStep { name; source; sql; params }`,
    `ApiStep { name; source; operation; args }`,
    `ArgBinding = { input: string } | { value: InputScalar }`,
    `ArtifactV2 { unsatisfiable; steps: (SqlStep | ApiStep)[]; shapeJs; assumptions }`,
    `AnyArtifact = Artifact | ArtifactV2`.
  - Add the guards `isArtifactV2(a)` (`'steps' in a`) and `isApiStep(s)`
    (`'operation' in s`).
  - Add `ArtifactV2Schema` (zod) to `schemas.ts`.
  - Change `HandlerRecord.artifact` to `AnyArtifact`.
  - `OfflineHandlers` becomes `Readonly<Record<string, AnyArtifact>>`.
- **Tests:** `core/test/models/schemas.test.ts` (new): valid and invalid v2 artifacts.
- **Done when:** typecheck passes everywhere `artifact.sql` is read. Each such
  place either narrows with `isArtifactV2` or is reached only by v1 artifacts.
  Leave `// MS3` where the narrowing is the reason.

### P2.3 Step lint (4 h)
- **Files:** new `core/src/engine/checks/steps.ts`; edit `core/src/engine/checks/sql.ts` (export the per-SQL checks with a `{ sql, params, shapeJs }` input).
- **Change:** `lintSteps(artifact, context)`. The context is
  `{ sqlSourceName, apiSchemas, input, maxSteps }`. Each rule of design §3.5
  throws `INVALID_HANDLER` with one sentence:
  - steps count between 1 and `maxSteps`;
  - unique identifier names (`STEP_NAME = /^[a-z][A-Za-z0-9]*$/`);
  - the source exists and is of the right kind;
  - the operation exists;
  - args name declared params;
  - each `input` binding names an input key;
  - constants match the param type and `values`;
  - no input string value equals a constant;
  - `shapeJs` present when there is more than one step;
  - each SQL step passes `assertReadOnlySql`, placeholder mapping and the
    hard-coded check.

  An input bound to a param whose type disagrees with the input's recorded
  type throws `INVALID_REQUEST`. Map leaf types to `ParamType`: `string`,
  `date` and `datetime` → `string`; `integer` and `number` → `number`;
  `boolean` → `boolean`.
- **Tests:** `core/test/engine/checks/steps.test.ts`: one passing artifact and
  one failing case per rule.
- **Done when:** every rule in design §3.5 has a test.

### P2.4 Sandbox: the `data` convention (2 h)
- **Files:** `core/src/sandbox/types.ts`, `core/src/sandbox/quickjs/quickjs-runner.ts`.
- **Change:**
  - `ShapeJob` becomes a union: `{ code, rows, input }` (v1) or
    `{ code, data, input }` (v2).
  - `toProgram` emits `shape(<data>, <input>)` for v2.
  - Before building the program, reject values that are not plain JSON (a
    function or a bigint) with `SANDBOX_ERROR` (S4).
- **Tests:** `core/test/sandbox/quickjs.test.ts`:
  - v2 `shape(data, input)` returns a joined result;
  - a bigint in rows is rejected;
  - the existing isolation tests are unchanged.
- **Done when:** tests pass.

### P2.5 Step executor (6 h)
- **Files:** new `core/src/engine/execute-steps.ts`, new `core/src/sources/redact.ts`; edit `core/src/engine/execute.ts` (dispatch).
- **Change:**
  - `executeArtifact` keeps the v1 path untouched. A v2 artifact goes to
    `executeSteps(deps, job)`; `deps` gains `sources`.
  - `executeSteps`:
    1. Creates one `AbortController`.
    2. Runs all steps with `Promise.allSettled`:
       - a SQL step calls `connector.run(sql, bindParams(params, input), queryLimits(limits))`;
       - an API step resolves its args (an input value, or the constant) and
         calls `source.call(operation, args, { timeoutMs: limits.statementTimeoutMs, rowCap: limits.rowCap, signal })`.
    3. On the first API failure, calls `abort()`. A running SQL step is not
       cancelled; its result is discarded.
    4. Turns any API failure into `SlimeError('SOURCE_ERROR', redactSecrets(message, source.secrets), { retryable: true, details: { source: name } })`.
    5. If more than one step ran and any result has `truncated`, throws
       `QUERY_TOO_LARGE` naming the step (MS6).
    6. Builds `data = { [step.name]: rows }`. With `shapeJs`, runs the sandbox
       with the v2 job; without it (one step only), passes rows through.
    7. Calls `assertValidOutput`.
    8. Returns an `Execution` with a new `steps: StepTiming[]` (`{ name, source, rows, ms }`).
  - `redactSecrets(text, secrets)` replaces every non-empty secret with `[redacted]`.
- **Tests:** `core/test/engine/execute-steps.test.ts` with `fakeApiSource` and a stub SQL connector:
  - combined output;
  - parallel start (both calls begin before either ends);
  - an API failure gives `SOURCE_ERROR` with no secret in the message or `toJSON()`;
  - the other API step sees `signal.aborted`;
  - truncation in a two-step handler gives `QUERY_TOO_LARGE`;
  - a single step without `shapeJs` returns rows.
- **Done when:** tests pass.

### P2.6 Generation and saving (5 h)
- **Files:** `core/src/engine/generate.ts`, new `core/src/engine/normalize-artifact.ts`, `core/src/engine/slime-engine.ts`, `core/src/engine/review-loop.ts` (types only).
- **Change:**
  - `GenerationDeps` gains `sources`, `apiSchemas`, `sqlSourceName`.
  - `tryArtifact` handles v2:
    1. runs `lintSteps`;
    2. runs `connector.check` for each SQL step, with the existing cost limit;
    3. runs `executeSteps`.
  - `GenerationRequest` gains `format: 'v1' | 'v2'`. The engine sets `'v2'`
    when `config.hasApiSources`.
  - `normalizeArtifact(artifact)`, called in `newRecord`: a v2 artifact with
    exactly one SQL step becomes v1 (refinement 2). The rename uses
    `acorn` / `acorn-walk` (already dependencies). If the `shape` declaration
    can't be found, normalization is skipped and the artifact is stored as v2.
  - `slime-engine.ts`:
    - `#runSaved` and `#generationDeps` pass sources;
    - `close` closes all sources (from P1.6);
    - `#answer` reads `artifact` through the meta helper (P2.7).
- **Tests:** `core/test/engine/multi-source.test.ts` (new): an offline
  generator returning v2 artifacts, `memoryStore`, `fakeApiSource` and the demo
  Postgres (`test/support/database.ts`, skipped without `REQUIRE_DB`, as
  `postgres.test.ts` is). Cases:
  - a combined query returns the expected output;
  - 3 runs promote to liquid with no reviewer;
  - with a stub reviewer that approves, it is promoted after review;
  - locked mode (no generator) serves the saved v2 handler;
  - a `fakeApiSource` failure is final (no repair attempt: the offline
    generator is called once);
  - a single-SQL-step v2 artifact is stored as v1 and its result is identical.
- **Done when:** tests pass.

### P2.7 Meta and events (3 h)
- **Files:** `core/src/engine/meta.ts`, `core/src/config/options.ts` (`GeneratedEvent`), `core/src/engine/types.ts` (`QueryMeta`), the generated-event builder in `slime-engine.ts`.
- **Change:**
  - `QueryMeta` gains `steps?: { name; source; rows; ms }[]` and
    `handlerSteps?: (SqlStep | ApiStep)[]`, both explore mode only (R9).
  - For v2, `meta.sql` is the joined SQL steps (refinement 4).
  - `GeneratedEvent` gains `steps?`.
- **Tests:** `core/test/engine/engine.test.ts`: v2 meta in explore mode has
  `steps` and `handlerSteps`; locked mode has neither.
- **Done when:** tests pass; `core/docs/request-format.md` matches (P0.2).

### P2.8 Crystal skip (2 h)
- **Files:** `core/src/crystallize/crystallize.ts`.
- **Change:** records whose artifact is v2 (by P2.6 they have an API step)
  are skipped and listed in the job's report as `skipped: has API steps`
  (MS9). v1 records, including normalized ones, go through unchanged.
- **Tests:** `core/test/crystallize/crystallize.test.ts`: a v2 record is skipped
  and reported; a normalized single-SQL record is crystallized (S3).
- **Done when:** tests pass.

### P2.9 v1 handler fixtures (1 h)
- **Files:** new `core/test/fixtures/v1-handlers/plans-accounts.json` and `top-accounts.json`; a test in `core/test/compat/v1-handlers.test.ts`.
- **Change:** generate the two records by running `examples/express` once
  offline against the demo database. Copy them from `.slime/handlers/`, which
  is gitignored, so commit the copies here. The test loads them into a
  `memoryStore` and serves them in locked mode.
- **Done when:** the test passes on this branch.

### P2.10 Security tests S9 (1 h)
- **Files:** `core/test/engine/multi-source.test.ts`.
- **Change:** an artifact with `maxSteps + 1` steps is refused; a step over
  `rowCap` in a two-step handler fails (MS5, MS6).
- **Done when:** tests pass.

## 6. Phase P3: models (1–1.5 d)

### P3.1 Multi-source prompts (4 h)
- **Files:** `core/src/models/prompts.ts`.
- **Change:**
  - Add `MULTI_SOURCE_GENERATION_INSTRUCTIONS`, `MULTI_SOURCE_ARTIFACT_JSON_FORMAT`
    and `MULTI_SOURCE_REVIEW_INSTRUCTIONS`, starting from the P0.3 draft. They
    cover:
    - steps;
    - `input` and `value` bindings;
    - `shape(data, input)`;
    - joining on columns whose comment says `matches …`;
    - "use one SQL step if the database alone answers".
  - `reviewMessage` renders each step: SQL or `operation(args)`.
  - **Do not edit** the existing constants. Their bytes are pinned by P1.7.
- **Tests:** `core/test/models/prompt-hash.test.ts`: the v1 hashes are
  unchanged; the multi-source hashes differ from them.
- **Done when:** tests pass.

### P3.2 Roles pick the format (3 h)
- **Files:** `core/src/models/roles.ts`, `core/src/models/types.ts`.
- **Change:**
  - `Generator` gains `readonly multiSourcePromptHash?: string`.
  - `generatorFor` computes it from the multi-source parts.
  - `generate()` picks instructions, JSON format and schema (`ArtifactSchema`
    or `ArtifactV2Schema`) by `request.format`.
  - The reviewer picks its instructions by `isArtifactV2(request.artifact)`.
- **Tests:** `core/test/models/groq.test.ts` and `claude.test.ts`, with their
  existing fetch or SDK stubs: a v2 request sends the multi-source
  instructions and parses a v2 reply.
- **Done when:** tests pass.

### P3.3 Provenance and validation (1 h)
- **Files:** `core/src/create-slime.ts`, `core/src/config/validate.ts`.
- **Change:**
  - `currentProvenance` uses `generator.multiSourcePromptHash` when
    `config.hasApiSources`.
  - Validation: API sources plus a generator without `multiSourcePromptHash`
    is a config problem.
  - The offline generator sets both hashes to its handlers' hash.
- **Tests:** config test for the new problem; P1.7 still passes.
- **Done when:** tests pass.

### P3.4 Live check (2 h)
- **Files:** new `core/test/live/multi-source.live.test.ts`, run only with `LIVE=1`.
- **Change:** a real Groq or Claude generator, the demo database and a
  `fakeApiSource` shaped like Notion `feedback`. Ask demo intent 1 and assert:
  - the output shape is valid;
  - the handler has two steps.
- **Done when:** one green run, pasted into the P3 pull request.

## 7. Phase P4: generic API source (1–1.5 d)

### P4.1 Shared HTTP helper (3 h)
- **Files:** new `core/src/shared/http.ts`; edit `core/src/models/groq/groq-client.ts`.
- **Change:** move the timeout (`AbortSignal.timeout` +
  `AbortSignal.any`), transient-retry and `Retry-After` logic out of
  `groq-client.ts` into `fetchWithRetry(request: HttpAttempt): Promise<Response>`.
  `HttpAttempt` holds:
  - `url`, `init`, `timeoutMs`, `signal?`;
  - `maxTransientRetries`, `maxRetryWaitMs`;
  - `fetchImpl?`, defaulting to global `fetch`.

  `groq-client.ts` calls it. Its behaviour, error codes and messages are
  unchanged.
- **Tests:** `core/test/shared/http.test.ts` (new): timeout, abort, a 429 with
  `Retry-After`, transient retries. `groq.test.ts` passes unchanged.
- **Done when:** both pass.

### P4.2 `SourceError` (1 h)
- **Files:** new `core/src/sources/source-error.ts`.
- **Change:** `class SourceError extends Error { status: number | null; isRetryable: boolean }`.
  Its message never holds headers or response bodies. Export it from the main
  entry.
- **Tests:** covered by P4.3.

### P4.3 Constrained client (5 h)
- **Files:** new `core/src/sources/api/http-client.ts`.
- **Change:** `createHttpClient(options: HttpClientOptions)`. The options are
  `{ baseUrl, headers?, secrets, fetchImpl?, timeoutMs, signal }`, and the
  client returns `{ getJson(path, { query }), request({ method, path, query?, body? }) }`.
  It enforces (MS10, S1, S2):
  - **Path:** must match `SAFE_PATH = /^\/[A-Za-z0-9\-._~\/]*$/` and contain no
    `..`.
  - **Query:** values go through `URLSearchParams`; null and undefined are
    dropped.
  - **Redirects:** `redirect: 'manual'`; any 3xx is a `SourceError`.
  - **Size:** responses over `MAX_RESPONSE_BYTES` (10 MB) are a `SourceError`.
  - **Parsing:** JSON parse errors are a `SourceError`.
  - **Messages:** every message goes through `redactSecrets`.
  - **Retries:** a 429 is retried through `fetchWithRetry` within `timeoutMs`.
- **Tests:** `core/test/sources/http-client.test.ts`:
  - inputs with `../`, `?`, `#` and full URLs keep the host and are encoded;
  - a 302 to another origin fails;
  - an oversize body fails;
  - a 500 body containing the token yields a message without it.
- **Done when:** S1 and S2 tests pass.

### P4.4 `defineApiSource` (4 h)
- **Files:** new `core/src/sources/api/define-api-source.ts`; export from `core/src/index.ts`; `package.test.ts`.
- **Change:** `defineApiSource(declaration)`. The declaration is
  `{ service, baseUrl, headers?, secrets?, operations, check? }`.
  - **At definition time** it validates param and column types against the
    leaf types, and throws `SlimeConfigError` with every problem.
  - **`describe()`** returns operations in declaration order. Columns are
    `not null` unless the type has `|null`; `comment`s are carried through.
  - **`call()`** checks the operation and args (unknown → `SourceError`). It
    builds an `http` client for this call (its `signal`, `timeoutMs`, `secrets`)
    and runs `run(args, { http, signal })`. It cuts rows at `rowCap`, setting
    `truncated`, and measures `ms`.
  - **`safetyCheck()`** runs the optional `check` (for example a cheap GET) or
    returns `{ ok: true, user: service, problems: [] }`.
- **Tests:** `core/test/sources/define-api-source.test.ts`: declaration
  validation, unknown operations, `rowCap`, describe order.
- **Done when:** tests pass.

### P4.5 Fixture fetch and recorder (3 h)
- **Files:** new `core/src/testing/fixture-fetch.ts` (exported from `./testing`); new `core/scripts/record-fixtures.mjs`.
- **Change:**
  - `fixtureFetch(dir)` returns a `fetch` implementation. It maps
    `METHOD path?sortedQuery` (plus a body hash for POST) to `<dir>/<slug>.json`,
    which holds `{ status, headers, body }`. It throws on any unrecorded method
    or path (S10).
  - The recorder is `node core/scripts/record-fixtures.mjs <source> <out-dir>`.
    It wraps `fetch`, runs a small per-source scenario file, scrubs tokens and
    ids (`SCRUB_PATTERNS`), and writes the fixtures.
- **Tests:** `core/test/testing/fixture-fetch.test.ts`: hit, miss, unknown method.
- **Done when:** tests pass.

### P4.6 `apiSourceContract` (3 h)
- **Files:** new `core/src/testing/api-source-contract.ts`.
- **Change:** a `node:test` suite factory like `connector-contract.ts`. It
  takes `(makeSource, cases)`, where `cases` names one operation, valid args,
  args for null params and an expected row count. Assertions:
  - `describe` is valid and identical on two calls;
  - rows match the declared types, and nulls only where nullable;
  - null params return at least as many rows as filtered ones;
  - `rowCap: 1` sets `truncated`;
  - an aborted signal rejects;
  - unknown operations and args are rejected;
  - errors contain none of `source.secrets`.
- **Tests:** run the contract against `fakeApiSource` in `core/test/sources/fake-api-source.test.ts`.
- **Done when:** the contract passes for the fake.

### P4.7 Ghibli source in the example (3 h)
- **Files:** new `examples/multi-source/package.json` (dependencies: `@slime-cloud/core` as `file:../../core`, `hono`, `@hono/node-server`, `pg`), `src/films.mjs`, `test/films.test.mjs`, `test/fixtures/ghibli/*.json`.
- **Change:**
  - `films.mjs` is design §4.1's `ghibliFilms`, plus a `check` that GETs
    `/films?limit=1`.
  - Record fixtures with the P4.5 recorder.
  - The test runs `apiSourceContract` with `fixtureFetch`.
- **Done when:** `npm test` in `examples/multi-source` passes offline.

## 8. Phase P5: Notion (2–3 d)

Confirm against Notion's documentation before coding:
- the pinned version header;
- the data source retrieve and query response shapes;
- whether properties carry a `description` (Q13);
- whether an integration's capabilities can be read through the API;
- how to create a database with an initial data source under the pinned
  version.

Note each answer in the P5 pull request.

### P5.1 Package entry (1 h)
- **Files:** new `core/src/sources/notion/index.ts`; `core/package.json` (export `"./notion"`); `core/test/package.test.ts`.
- **Change:** export `notionSource` and its option types.
- **Done when:** the package test passes.

### P5.2 Schema mapping and column names (4 h)
- **Files:** new `core/src/sources/notion/notion-schema.ts`.
- **Change:**
  - `operationFromDataSource(alias, dataSource, { exclude, comments })` returns
    `OperationInfo`, using design §4.2's table.
  - Every column is nullable, plus `id string not null` as the primary key.
  - `columnName(propertyName)`: NFKD, strip non-ASCII, camelCase. Collisions get
    a numeric suffix in Notion's property order.
  - The comment is `comments[alias][column]`, else the property `description`
    if present.
  - Generated params:
    - equality on select, status and checkbox;
    - `<column>From` / `<column>To` on date and created_time.

    The params use the same camelCase rule, so `created_from` in the design
    example becomes `createdFrom`.
- **Tests:** `core/test/sources/notion/notion-schema.test.ts`:
  - every property type in the table;
  - excluded types absent;
  - collision suffix;
  - `exclude` and `comments`.
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

### P5.4 `notionSource` (4 h)
- **Files:** new `core/src/sources/notion/notion-source.ts`.
- **Change:** `notionSource({ token, notionVersion, dataSources, exclude?, comments?, fetchImpl? })`.
  - **Base URL:** `https://api.notion.com`.
  - **Headers:** `Authorization: Bearer`, `Notion-Version`.
  - **Secrets:** `[token]`.
  - **`describe()`:** `GET /v1/data_sources/{id}` per alias, then
    `operationFromDataSource`.
  - **`call()`:** `POST /v1/data_sources/{id}/query` with `filter` and
    `page_size: 100`. It follows `next_cursor` while `has_more`, stopping at
    `rowCap`. It sets `truncated` at `rowCap` or on
    `request_status.type === 'incomplete'`.
  - **`safetyCheck()`:** `GET /v1/users/me` for `user` (the bot name), and
    every data source retrievable.
- **Tests:** `core/test/sources/notion/notion-source.test.ts`:
  `apiSourceContract` over `fixtureFetch('core/test/fixtures/notion')`;
  pagination stops at `rowCap`; a 429 then 200 succeeds.
- **Done when:** the contract passes over fixtures.

### P5.5 Seed script and fixtures (4 h)
- **Files:** new `examples/multi-source/scripts/seed-notion.mjs`; new `core/test/fixtures/notion/*.json`; a scenario file for the recorder.
- **Change:**
  - **Seed script.** It reads `NOTION_SEED_TOKEN`, `NOTION_PARENT_PAGE_ID` and
    `DATABASE_URL`. It creates "Customer feedback" and "Movie nights" with the
    design §4.2 properties, adds about 40 and 15 pages, and prints the two data
    source ids.
  - **Feedback data:**
    - account names come from `SELECT name FROM accounts ORDER BY id LIMIT 20`;
    - sentiment and status are spread so that intent 1 has non-zero counts;
    - Area is multi-select; Created dates fall in the last 90 days.
  - **Movie nights data:** films come from the Ghibli fixture titles.
  - Record Notion fixtures with Slime's read-only token.
- **Done when:** a fresh Notion workspace can be seeded with one command, and
  the fixtures are committed with no token or workspace ids.

### P5.6 Security tests S6 and S8 (2 h)
- **Files:** `core/test/sources/notion/notion-source.test.ts`, `core/test/engine/multi-source.test.ts`.
- **Change:**
  - **S6:** the dictionary snapshot for the fixture schema contains no `people`
    column and no `exclude`d property.
  - **S8:** a spy generator records every prompt. Run demo intent 1 offline
    over the Notion fixtures and assert that no seeded page title appears in
    any prompt.
- **Done when:** tests pass.

## 9. Phase P6: example, tests, docs (1.5–2 d)

### P6.1 Example app (4 h)
- **Files:** `examples/multi-source/src/server.mjs`, `src/config.mjs`, `offline-handlers.json`, `.env.example`, `.gitignore`, `README.md`.
- **Change:**
  - **`server.mjs`:** the Hono server from `examples/hono`, with `GET /health`
    and `POST /slime`.
  - **`config.mjs`:**
    - `sources`: `db` from `DATABASE_URL` (default: the demo database),
      `notion` from `NOTION_TOKEN` and `NOTION_FEEDBACK_ID` /
      `NOTION_MOVIE_NIGHTS_ID`, and `films` from `src/films.mjs`;
    - `comments`: `{ feedback: { account: 'matches db.accounts.name' }, movieNights: { film: 'matches title in films operation films.list' } }`;
    - the generator: Groq if `GROQ_API_KEY`, else Claude, else the offline
      generator over `offline-handlers.json`, which holds v2 artifacts for the
      three demo intents;
    - `FETCH_FIXTURES=1` swaps in `fixtureFetch` for CI.
  - **README:** setup, seeding, and the S7 warning (explore mode only in
    development).
- **Done when:** `npm start` answers the three intents with
  `FETCH_FIXTURES=1` and the offline generator.

### P6.2 Example smoke test (2 h)
- **Files:** `examples/multi-source/test/app.test.mjs`.
- **Change:** start the app in-process with `FETCH_FIXTURES=1` and the offline
  generator, `POST /slime` each demo intent, and assert the output shape and
  non-empty data (T7).
- **Done when:** the test passes against the demo database.

### P6.3 CI job (1 h)
- **Files:** `.github/workflows/ci.yml`.
- **Change:** a job `example-multi-source`, copied from the existing `example`
  job. It uses the same Postgres service, `init.sql` and packed tarball, with
  `working-directory: examples/multi-source`.
- **Done when:** the job is green on the P6 pull request.

### P6.4 Engine tests over fixtures (2 h)
- **Files:** new `core/test/engine/multi-source-fixtures.test.ts`.
- **Change:** the T4 cases from design §7 that need the real adapters:
  - the combined query over the Notion and Ghibli fixtures;
  - a Notion schema fixture with one added property changes `schemaHash`
    (explore regenerates, locked warns);
  - a fixture returning 503 gives a retryable `SOURCE_ERROR`.
- **Done when:** tests pass in CI.

### P6.5 Live run and bench (3 h)
- **Files:** `core/bench/protocol-cases.md` (or the bench case file), a `LIVE=1` script in `examples/multi-source`.
- **Change:** run the three intents against seeded Notion, the Ghibli API and a
  real model. Repeat each `gasToLiquidRuns` times and confirm promotion. Add
  the intents as bench cases.
- **Done when:** results (output, steps, promotion) are pasted into the P6
  pull request.

### P6.6 Documentation (3 h)
- **Files:**
  - `core/docs/request-format.md`: confirm the P0.2 section matches the code.
  - `core/README.md`: sources, `defineApiSource`, `@slime-cloud/core/notion`.
  - `README.md`: add `examples/multi-source/` to the map.
  - `docs/README.md`: list both multi-source documents.
  - `core/docs/multi-source.md`: Status → Current for what shipped.
  - `core/PLAN.md`: a milestone row "M8 multi-source" with its checks.
- **Done when:** a reader can set up the example from the README alone.

## 10. Order and dependencies

| Phase | Needs | Can run alongside |
|---|---|---|
| P0 | — | — |
| P1 | P0 | — |
| P2 | P1 | P4.1–P4.3 |
| P3 | P2 (types, offline v2) | P4, P5 |
| P4 | P1 (types) | P2, P3 |
| P5 | P1, P4.3–P4.6 | P3 |
| P6 | P2, P3, P4, P5 | — |

The critical path is P0 → P1 → P2 → P3 → P6. A second developer takes P4 and
then P5.

## 11. Out of scope

- S5 in `platform/runtime` (load only the secrets the runtime needs). Track it
  as its own issue.
- Everything under design §10 "Later (P7)".
