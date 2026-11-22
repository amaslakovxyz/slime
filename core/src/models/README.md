# models

## Overview

The model ports and everything providers share, so a bench compares models,
not prompts.

- `types.ts`: the ports the engine calls: `Generator`, `Reviewer` and
  `Optimizer`, with the request and result types.
- `artifact.ts`: `Artifact`, the handler a model writes (steps plus
  `shapeJs`); `fromStoredArtifact` reads the older single-query form from
  stored records, and `asSingleQuery` gives Crystal its one-query form (MS3).
- `model-client.ts`: `ModelClient`, the one interface a provider implements.
- `roles.ts`: `modelRoles(client)` builds the Generator, Reviewer and
  Optimizer from a client, with the shared prompts, schemas and prompt hash;
  `providerRoles(clientFor)` turns a client factory into a provider's entry.
- `prompts.ts`: the instructions, the JSON reply formats for providers
  without schema-constrained output, the user messages, and `promptHash()`.
- `schemas.ts`: the zod schemas a reply must match.
- `json-reply.ts`: `parseJsonReply`, for providers in `'prompt'` output mode.
- `index.ts`: the `@slime-cloud/core/models` entry, for providers outside core.

Providers, each its own subpath:

- [claude/](./claude/README.md): `@slime-cloud/core/claude` (needs `@anthropic-ai/sdk`).
- [groq/](./groq/README.md): `@slime-cloud/core/groq` (plain `fetch`).
- [offline/](./offline/README.md): `@slime-cloud/core/offline`, a `Generator`
  that serves hand-written handlers, for tests and CI.

## Interface

`ModelClient` (`model-client.ts`):

- `provider` and `model`: recorded in handler provenance.
- `outputMode`: `'native'` when the provider enforces the reply schema,
  `'prompt'` when the JSON format must be spelled out in the instructions.
- `call({ instructions, context?, message, schema, timeoutMs, signal?, label })`:
  one request, returning `{ value, usage }`. `context` is the dictionary, the
  same on every call, so a provider may cache it with the instructions.

## Adding a provider

1. Create `<name>/<name>-client.ts` exporting `<name>Client(options): ModelClient`:
   - pick `outputMode`; in `'prompt'` mode, validate the reply with
     `parseJsonReply`;
   - honour `timeoutMs` and `signal`;
   - report time spent waiting on rate limits as `usage.waitMs`, not `ms`;
   - throw `SlimeError`s: `GENERATION_RATE_LIMITED` and `GENERATION_TIMEOUT`
     (retryable), `GENERATION_FAILED` (retryable for a 5xx or a reply with
     wrong fields, final for a bad key or a refusal).
2. In `<name>/index.ts`, export `<name> = providerRoles(<name>Client)`, as
   `claude/index.ts` does. Prompts, schemas and roles are never per provider.
3. Add a `./<name>` entry to `package.json` `exports` (and an optional peer
   dependency if it needs an SDK), and the subpath to `test/package.test.ts`.
4. In `test/models/<name>.test.ts`, call `describeModelClientContract` from
   `@slime-cloud/core/testing`, turning each scenario into a stubbed
   transport (see `test/models/groq.test.ts`).
5. Optionally, `npm run bench` with an API key for a real run.

A provider outside core does the same against `@slime-cloud/core/models` and
`@slime-cloud/core/testing`.

## Invariants

- **The prompts follow the request format (§4):**
  - every parameter may be `null`, meaning "not given";
  - `limit` and `offset` page the top-level list;
  - the type `unknown` means only `null` has been seen;
  - `date` and `datetime` leaves;
  - a top-level object is one row, and `shapeJs` returns it or `null`;
  - the dictionary's rules win over the model's own judgment.
- **One set of prompts** for every instance, with or without API sources.
- **Byte-stable.** `promptHash(provider, ...parts)` (16 hex characters) is
  recorded in every handler; editing a prompt, or how `roles.ts` assembles
  it, regenerates saved handlers. `test/models/prompt-hash.test.ts`
  pins the current hashes.
- **Never values or rows.** A model sees parameter names and types, never
  input values or rows. The optimizer sees only code, never the intent.

## Side Effects

- None here; providers call their APIs.

## Verification

- `describeModelClientContract` (`../testing/model-contract.ts`) is the
  contract every provider's client must pass.
- `test/models/prompt-hash.test.ts` pins the Claude and Groq prompt hashes.
