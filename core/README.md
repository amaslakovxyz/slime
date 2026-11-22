# @slime-cloud/core

## System Overview

The Slime engine as a library. An app installs it and uses it in three steps:

1. create a connector, which says where the data comes from;
2. create a Slime instance from a config;
3. call `slime.query()` inside any endpoint, in any Node framework.

```ts
const connector = postgresConnector({ url: process.env.READER_URL! });
const slime = await createSlime(new SlimeConfig({ connector, generator }));

// inside any endpoint
const { data, meta } = await slime.query({
  intent: 'top N accounts by total paid amount, highest first',
  input: { limit: 5, country: 'DE' },
  output: [{ name: 'string', totalPaid: 'integer' }],
});
```

The first time Slime sees a request, a model writes a read-only SQL query
plus an optional shaping function. Slime checks and runs them, then caches the
result as a handler. Repeat requests reuse the handler, even with different
input values. Handlers move up through three tiers:

* **Gas:** newly generated, held in memory, and expires.
* **Liquid:** has proven itself and passed a background review (when a
  reviewer is configured); saved in a store.
* **Crystal:** rewritten by an agent into JS modules (with `.d.ts`) in the app's own
  code, and passed to Slime through the config. A host that keeps the modules
  elsewhere (Slime Cloud keeps them in S3) loads them as data instead: its
  Crystal shapes are source strings, and they run in the shaping sandbox.

**Multi-source handlers.** Besides its one SQL source, an instance can read
read-only API sources, and one handler can combine them. Notion ships as
`@slime-cloud/core/notion`; any other REST API becomes a source with
`defineApiSource`. The engine calls the sources and the model only plans:
model code never does I/O or sees credentials. With no API source configured
nothing changes. The design and threat model are in
[docs/multi-source.md](docs/multi-source.md), and the example in
[examples/multi-source](../examples/multi-source/README.md).

```ts
const slime = await createSlime(new SlimeConfig({
  sources: {
    db: postgresConnector({ url: process.env.READER_URL! }),
    notion: notionSource({ token, dataSources: { feedback: '<data source id>' }, comments: { feedback: { account: 'matches db.accounts.name' } } }),
  },
  generator,
}));
```

> **Status:** M5 is done: Crystal. `crystallize()` (`@slime-cloud/core/crystallize`)
> turns proven Liquid handlers into `.mjs` modules in the app's code, and the
> app passes the generated `index.mjs` as `crystal`. `slime-crystal check`
> re-checks the folder in CI: an imported Crystal runs without a sandbox, so
> **run it in your CI**. M4 (Claude and Groq models, review, promotion) is built; its live
> run against a real model is still pending (`npm run bench` with an API key). Decisions and
> milestones are in [PLAN.md](PLAN.md). The request format is in
> [docs/request-format.md](docs/request-format.md), and an app using the
> package is in [examples/express](../examples/express/README.md).

### Scope

**In core:**

* the engine and tiers, the request format, safety checks, the QuickJS
  shaping sandbox, the background review and Crystal loading;
* the contracts (Ports) for sources, generators, reviewers and stores;
* their first implementations:
  * the Postgres connector, the Notion API source and `defineApiSource` for
    other REST APIs (read-only, through a constrained HTTP client);
  * Claude, Groq and offline generators;
  * stores for Slime's own state: files (the default) and memory, with no
    extra packages. Any other backend (Postgres, DynamoDB, Redis) is a custom
    `SlimeStore` the app passes in.

**Not in core:**

* HTTP. The app's own endpoints call `slime.query()`. The standalone
  server, API keys and CLI belong to `@slime-cloud/server`, owned by others;
* Slime Cloud and tenancy (`platform/`, owned by others);
* writes.

### Where this comes from

* [concepts_brief.md](../docs/product/concepts_brief.md): the v0 concept and the
  benchmark results.
* `sandbox/`: the first prototype, which core was rebuilt from. It was
  deleted in M6 and stays in git history.
* PR #7, `docs/oss-saas-split-design.md`: the layers (core → server →
  platform) and the `@slime-cloud` name.

## Subdirectories & System Boundaries

- [src/](./src/README.md): the package sources, grouped by what the system
  is made of. Its README is the map: the four ports (`sources/`,
  `models/`, `stores/`, `sandbox/`, each a `types.ts` contract plus
  implementations), the engine (`engine/`, `request/`, `dictionary/`),
  `config/`, `shared/`, and the tooling (`crystallize/`, `testing/`).
  - [src/sources/sql/](./src/sources/sql/README.md) and
    [src/models/](./src/models/README.md) say how to add a connector or a
    model provider.
- `scripts/check-pack.mjs`: guards what `npm pack` ships; its required files
  come from `package.json` `exports` and `bin`.
- `bench/`: `npm run bench`. `cases.mjs` holds 8 cases with reference
  queries; `run.mjs` runs them through the built package against the demo
  database, with Groq, Claude (given an API key), or the example's offline
  handlers.
- `test/`: `node:test` suites run through `tsx`, mirroring `src/`;
  `test/support/` holds the database helpers.
- `docs/`: [request-format.md](./docs/request-format.md) is the request
  format for app developers: fields, output notation, parameters, `meta`,
  errors and modes. [multi-source.md](./docs/multi-source.md) is the
  multi-source design and [multi-source-implementation.md](./docs/multi-source-implementation.md)
  its step-by-step plan.
- `src/sources/`: the `ApiSource` port, the redacting `callSource` wrapper,
  `api/` (`defineApiSource` and the constrained HTTP client) and `notion/`.

## Global Invariants

- **One main entry, plus adapter subpaths.** `package.json` `exports` has
  `.`, `./postgres`, `./models`, `./claude`, `./groq`, `./offline`,
  `./crystallize`, `./testing` and `./shape-worker` (C7), plus the
  `slime-crystal` bin. `test/package.test.ts` pins every entry's value exports.
- **What ships.** ESM only (`type: module`), Node `>=22`, compiled `dist/`
  and `README.md` only (`files`). `scripts/check-pack.mjs` enforces this in
  CI.
- **Private until go-public.** The package is `private: true`. Tests guard
  this, so nothing is published by accident.
- **Runtime dependencies.** `quickjs-emscripten` for the shaping sandbox,
  `zod` for checking model replies, and `acorn` with `acorn-walk` for the
  Crystal allowlist (loaded only by `./crystallize`). Drivers and model SDKs are
  optional peers (C7): `pg` for `./postgres`, `@anthropic-ai/sdk` for
  `./claude`. Groq is called with `fetch`.
- **No environment reading.** Core never reads `process.env` or `.env`. The
  app passes everything in through `SlimeConfig` (`src/config/slime-config.ts`).
- **No values in keys or prompts.** Input values are never part of a cache
  key (`src/request/key.ts:requestKey`). The generation and review requests
  carry only parameter names and coarse types
  (`src/models/types.ts:GenerationRequest.params`).
- **No Slime Cloud imports.** CI's "Core tests" job fails if `src/` mentions
  `@slime-cloud/runtime`, `@slime-cloud/server`,
  `@slime-cloud/control-plane` or `platform/runtime`
  (`.github/workflows/ci.yml`).

## Global Side Effects

- **At runtime:** none yet. Nothing in `src/` does I/O, network calls or
  keeps mutable module state.
- **When building:** `npm run build` writes `dist/` (`tsconfig.build.json`).
- **When packing:** `npm run check:pack` spawns
  `npm pack --dry-run --ignore-scripts` and writes no files.

## System Verification

- Run: `npm test -w @slime-cloud/core` (from the repository root)
- Full check, as CI does:
  `npm run typecheck -w @slime-cloud/core && npm test -w @slime-cloud/core && npm run build -w @slime-cloud/core && npm run check:pack -w @slime-cloud/core`,
  or `just core`.

Run from the repository root (npm workspaces):

```bash
npm install                              # once
npm run typecheck -w @slime-cloud/core
npm test -w @slime-cloud/core            # node:test, sources run through tsx
npm run build -w @slime-cloud/core       # dist/: compiled JS + .d.ts
npm run check:pack -w @slime-cloud/core  # what npm pack would ship
```
