# groq

## Overview

The `@slime-cloud/core/groq` entry (PLAN.md C7, M4): a `Generator`, a
`Reviewer` and an `Optimizer` (M5) on Groq's OpenAI-compatible chat API,
called with `fetch`, so it needs no extra package.

- `groq-client.ts`: `groqClient`, the `ModelClient` (`../model-client.ts`)
  for Groq in `'prompt'` output mode: one JSON-mode request, with retries and
  reply checks.
- `index.ts`: `groqGenerator`, `groqReviewer` and `groqOptimizer`, built by
  `modelRoles` (`../roles.ts`).

## Interface

- `groq.generator({ apiKey, model, reasoningEffort? })`,
  `groq.reviewer({ ... })` and `groq.optimizer({ ... })` (also exported as
  `groqGenerator`, `groqReviewer`, `groqOptimizer`). The sandbox benchmark
  used `openai/gpt-oss-120b`.

## Invariants

- **`apiKey` is required.** Core never reads `GROQ_API_KEY` itself.
- **JSON mode plus the shared zod schemas.** The prompt spells out the
  reply's keys; a reply with wrong or missing fields is a retryable
  `GENERATION_FAILED`.
- **Rate limits are waited out.** On a 429 the client waits (`retry-after`,
  at most 65 s, up to 6 times), and reports the time as `waitMs`, not model
  time; the engine doesn't count it against the generation budget.
- **Transient failures get two more tries:** dropped connections, replies
  Groq rejects as invalid JSON, and 5xx.
- **Cancellable.** The call's `signal` aborts the request and any further
  retries, with a final `GENERATION_FAILED`.
- **`reasoning_effort`** is sent only to models that reason before
  answering (`openai/gpt-oss-*`).

## Side Effects

- Calls the Groq API.

## Verification

- `test/models/groq.test.ts` uses a stubbed `fetch`: the ModelClient
  contract, the request shape and rate-limit waits.
- `npm run bench` with `GROQ_API_KEY` for a real run.
