# @slime-cloud/core

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
* **Liquid:** has proven itself and passed a background review; saved in a
  store.
* **Crystal:** rewritten by an agent into TS or JS modules in the app's own
  code, and passed to Slime through the config.

> **Status:** M0, the package skeleton, is done: it builds, tests and packs,
> but exports nothing yet. The API above is the target. Decisions and
> milestones are in [PLAN.md](PLAN.md).

## Development

Run from the repository root (npm workspaces):

```bash
npm install                              # once
npm run typecheck -w @slime-cloud/core
npm test -w @slime-cloud/core            # node:test, sources run through tsx
npm run build -w @slime-cloud/core       # dist/: compiled JS + .d.ts
npm run check:pack -w @slime-cloud/core  # what npm pack would ship
```

`just core` runs all of them, as CI's "Core tests" job does.

## Scope

**In core:** the engine and tiers, the request format, safety checks, the
QuickJS shaping sandbox, the background review, Crystal loading, and the
contracts (Ports) for connectors, generators, reviewers and stores, with
their first implementations: the Postgres connector; Claude, Groq and offline
generators; and stores for Slime's own state, chosen in the config: files
(the default) and memory with no dependencies, Postgres and DynamoDB as
optional adapters, or any custom store.

**Not in core:**

* HTTP. The app's own endpoints call `slime.query()`. The standalone
  server, API keys and CLI belong to `@slime-cloud/server`, owned by others;
* Slime Cloud and tenancy (`slime-cloud/`, owned by others);
* writes.

## Where this comes from

* [concepts_brief.md](../../../concepts_brief.md): the v0 concept and the
  benchmark results.
* [sandbox/](../../../sandbox/README.md): the first prototype. It is frozen
  and not used any more; core may copy code and tests from it.
* PR #7, `docs/oss-saas-split-design.md`: the layers (core → server →
  platform) and the `@slime-cloud` name.
