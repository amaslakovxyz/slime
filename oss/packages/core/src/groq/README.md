# groq

## Overview

The `@slime-cloud/core/groq` entry (PLAN.md C7, M4): a `Generator` and a
`Reviewer` on Groq's OpenAI-compatible chat API, called with `fetch`, so it
needs no extra package.

- `groq-client.ts`: one JSON-mode request, with retries and reply checks.
- `groq-models.ts`: `groqGenerator` and `groqReviewer`.

## Interface

- `groq.generator({ apiKey, model, reasoningEffort? })` and
  `groq.reviewer({ ... })` (also exported as `groqGenerator`,
  `groqReviewer`). The sandbox benchmark used `openai/gpt-oss-120b`.

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
- **`reasoning_effort`** is sent only to models that reason before
  answering (`openai/gpt-oss-*`).

## Side Effects

- Calls the Groq API.

## Verification

- `test/groq.test.ts` uses a stubbed `fetch`: the request shape, reply
  checks, rate-limit waits and error mapping.
- `scripts/live-run.mjs` with `GROQ_API_KEY` for a real run.
