# @slime-kit/core

The Slime engine as a library. An app installs it and uses it in three steps:

1. create a connector, which says where the data comes from;
2. create a Slime instance from a config;
3. call `slime.query()` inside any endpoint, in any Node framework.

```ts
const connector = postgresConnector({ url: process.env.READER_URL! });
const slime = await createSlime(new SlimeConfig({ connector, generator }));

// inside any endpoint
const { data, meta } = await slime.query({
  input: { from: 'accounts', where: { country: 'DE' }, orderBy: [{ totalPaid: 'desc' }], limit: 5 },
  output: [{ name: 'string', totalPaid: 'integer' }],
});
```

Names are the caller's own words and don't have to match the database. The
first time Slime sees a request, a model maps the names to the closest tables
and columns, then writes a read-only SQL query plus an optional shaping
function. Slime checks and runs them, then caches the
result as a handler. Repeat requests reuse the handler, even with different
input values. Handlers move up through three tiers:

* **Gas:** newly generated, held in memory, and expires.
* **Liquid:** has proven itself and passed a background review; saved in a
  store.
* **Crystal:** rewritten by an agent into TS or JS modules in the app's own
  code, and passed to Slime through the config.

> **Status:** design phase. Nothing in this folder runs yet. The API above is
> a draft. Decisions and build steps are in [PLAN.md](PLAN.md).

## Scope

**In core:** the engine and tiers, the request format, safety checks, the
QuickJS shaping sandbox, the background review, Crystal loading, and the
contracts (Ports) for connectors, generators, reviewers and handler stores,
with their first implementations (Postgres, Claude, Groq, offline).

**Not in core:**

* HTTP. The app's own endpoints call `slime.query()`. The standalone
  server, API keys and CLI belong to `@slime-kit/server`, owned by others;
* Slime Cloud and tenancy (`platform/`, owned by others);
* writes.

## Where this comes from

* [concepts_brief.md](../../../concepts_brief.md): the v0 concept and the
  benchmark results.
* [sandbox/](../../../sandbox/README.md): the working prototype. Core is
  rebuilt from it module by module; the sandbox stays as the reference until
  core matches it.
* PR #7, `docs/oss-saas-split-design.md`: the layers (core → server →
  platform) and the `@slime-kit` name.
