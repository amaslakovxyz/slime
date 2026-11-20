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
  code, and passed to Slime through the config.

> **Status:** M1 is done:
> * the request format and cache key;
> * the parameter type rules;
> * SQL lint;
> * the contracts (`Connector`, `Generator`, `Reviewer`, `SlimeStore`,
>   `SandboxRunner`);
> * `SlimeConfig` and `SlimeError`.
>
> `createSlime()`, `slime.query()`, `postgresConnector` and the generators
> come with M2 and later, so the example above does not run yet. It shows
> the target API. Decisions and milestones are in [PLAN.md](PLAN.md).

### Scope

**In core:**

* the engine and tiers, the request format, safety checks, the QuickJS
  shaping sandbox, the background review and Crystal loading;
* the contracts (Ports) for connectors, generators, reviewers and stores;
* their first implementations:
  * the Postgres connector;
  * Claude, Groq and offline generators;
  * stores for Slime's own state: files (the default) and memory, with no
    extra packages. Any other backend (Postgres, DynamoDB, Redis) is a custom
    `SlimeStore` the app passes in.

**Not in core:**

* HTTP. The app's own endpoints call `slime.query()`. The standalone
  server, API keys and CLI belong to `@slime-cloud/server`, owned by others;
* Slime Cloud and tenancy (`slime-cloud/`, owned by others);
* writes.

### Where this comes from

* [concepts_brief.md](../../../concepts_brief.md): the v0 concept and the
  benchmark results.
* [sandbox/](../../../sandbox/README.md): the first prototype. It is frozen
  and not used any more; core may copy code and tests from it.
* PR #7, `docs/oss-saas-split-design.md`: the layers (core → server →
  platform) and the `@slime-cloud` name.

## Subdirectories & System Boundaries

- [src/](./src/README.md): the package sources and its public entry
  `index.ts`. As of M1 that is `SlimeConfig`, the errors and the Port
  types. Pure building blocks live in:
  - [src/config/](./src/config/README.md): `SlimeConfig`'s option types,
    defaults and validation;
  - [src/request/](./src/request/README.md): request parsing, the output
    notation, parameter types and cache keys;
  - [src/checks/](./src/checks/README.md): SQL lint;
  - [src/store/](./src/store/README.md): the key-value store contract.
- [scripts/](./scripts/README.md): `check-pack.mjs`, which guards what
  `npm pack` ships.
- `test/`: `node:test` suites run through `tsx` (no contract file; tests
  only).
- `docs/`: design material, no code.
  [protocol-cases.md](./docs/protocol-cases.md) records the dropped
  structured protocol and 35 request cases kept for benchmarks.

## Global Invariants

- **One public entry.** `package.json` `exports` has only `.`
  (`dist/index.js` plus types). `test/package.test.ts` pins the value
  exports to `DEFAULT_LIMITS`, `DEFAULT_TIERS`, `SlimeConfig`,
  `SlimeConfigError` and `SlimeError`.
- **What ships.** ESM only (`type: module`), Node `>=22`, compiled `dist/`
  and `README.md` only (`files`). `scripts/check-pack.mjs` enforces this in
  CI.
- **Private until go-public.** The package is `private: true`. Tests guard
  this, so nothing is published by accident.
- **No runtime dependencies yet.** `package.json` has only
  `devDependencies`.
- **No environment reading.** Core never reads `process.env` or `.env`. The
  app passes everything in through `SlimeConfig` (`src/config.ts`).
- **No values in keys or prompts.** Input values are never part of a cache
  key (`src/request/key.ts:requestKey`). The generation and review requests
  carry only parameter names and coarse types
  (`src/ports.ts:GenerationRequest.params`).
- **No Slime Cloud imports.** CI's "Core tests" job fails if `src/` mentions
  `@slime-cloud/runtime`, `@slime-cloud/server`,
  `@slime-cloud/control-plane` or `slime-cloud/runtime`
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
