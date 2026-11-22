# Extending Slime

Slime's core is a small engine behind a few interfaces. Everything an app may
swap is one of them; each has a contract suite in `@slime-cloud/core/testing`
that a built-in or custom implementation must pass.

| What | Interface | Where it plugs in | Contract test | Effort |
|---|---|---|---|---|
| A REST API as a data source | `defineApiSource({ ... })` | `sources: { name: ... }` | `describeApiSourceContract` | Low: a declaration in app code |
| An API with its own logic (pagination, schema at startup) | `ApiSource` | `sources: { name: ... }` | `describeApiSourceContract` | Medium |
| Another database | `Connector` | `connector:` or `sources: { db: ... }` | `describeConnectorContract` | Medium, plus the Postgres gaps below |
| A model provider | `ModelClient` + `providerRoles` | `generator:`, `reviewer:`, crystallize's `optimizer:` | `describeModelClientContract` | Low: one `call` method |
| A custom generator or reviewer | `Generator`, `Reviewer` | `generator:`, `reviewer:` | none (use the fakes) | Low |
| Where Slime keeps its state | `SlimeStore` | `store:` | `describeStoreContract` | Low: four methods |
| Where shaping code runs | `SandboxRunner` | `createSlime(config, { runner })` | none | High: it is the security boundary |
| Observability | `onEvent(event)` | `onEvent:` | none | Low |

What is **not** an extension point: the request format, the tiers and their
promotion rules, the model-free checks on generated code, and the prompts.
They are the engine's behaviour, shared by every app so that a bench compares
models, not prompts.

## Data sources

An instance has exactly one SQL source and any number of API sources (MS1).
The model sees their schemas, never rows, and writes a handler whose steps read
from them ([src/sources/README.md](../src/sources/README.md)).

**A REST API.** Usually no adapter is needed:

```ts
import { defineApiSource } from '@slime-cloud/core';

const films = defineApiSource({
  service: 'Studio Ghibli API (public, read-only)',
  baseUrl: 'https://ghibliapi.example',
  operations: {
    'films.list': {
      columns: { id: 'string', title: 'string', year: 'integer' },
      run: async (_args, { http }) => http.getJson('/films'),
    },
  },
});
```

`run` gets only the declared params (`null` means "not given") and an HTTP
client that can reach only `baseUrl`. Declared `headers` and `secrets` are
redacted from every error and event.

**An API with its own logic.** Implement `ApiSource` (`src/sources/api/types.ts`):
`describe`, `call`, `safetyCheck`, `close`, and `secrets`. Throw `SourceError`
for a failed call; core adds the timeout, decides whether it is retryable,
and redacts secrets. `src/sources/api/notion/` is the reference.

**Another database.** Implement `Connector` (`src/sources/sql/types.ts`);
[src/sources/sql/README.md](../src/sources/sql/README.md) lists what the
contract requires (read-only transactions, both timeouts, `rowCap + 1`,
numbers as numbers, error codes). Two parts are Postgres-specific today and
must change with the first other database: the generation prompt
(`src/models/prompts.ts`, which also changes every `promptHash`) and the SQL
denylist (`src/artifact/checks/sql.ts`).

## Models

A provider implements one method:

```ts
import { providerRoles, type ModelClient } from '@slime-cloud/core/models';

function myClient(options: { apiKey: string; model: string }): ModelClient {
  return { provider: 'my-provider', model: options.model, outputMode: 'prompt', call: async (call) => { /* one request */ } };
}

export const myProvider = providerRoles(myClient); // myProvider.generator(...), .reviewer(...), .optimizer(...)
```

`outputMode: 'native'` when the provider enforces the reply schema, `'prompt'`
when the JSON format must be spelled out (validate with `parseJsonReply`).
Prompts, schemas and roles are shared, never per provider.
[src/models/README.md](../src/models/README.md) has the error and rate-limit
rules.

For tests and demos without a model, `offlineGenerator(handlers)` from
`@slime-cloud/core/offline` serves hand-written handlers by intent.

## State

`SlimeStore` is `get`, `put`, `list(ns, prefix?)` and `delete`, plus optional
`init` and `close` ([src/stores/README.md](../src/stores/README.md)). Core ships
`fileStore()` and `memoryStore()`; Slime Cloud's DynamoDB store is an app store
built the same way.

## Sandbox

`createSlime(config, { runner })` accepts any `SandboxRunner` (`run(job,
limits)`, `close()`). A host passes one to share a pool between instances; the
engine then leaves it running on `close()`. Generated code runs there with no
I/O, so a replacement must keep that guarantee: the default is QuickJS in
worker threads (`src/sandbox/quickjs/`).

## Events

`onEvent` receives `generated`, `reviewed`, `promoted`, `warning` and `error`
events (`src/config/events.ts`). A throwing handler never fails a query.
