# claude

## Overview

The `@slime-cloud/core/claude` entry (PLAN.md C7, M4): a `Generator`, a
`Reviewer` and an `Optimizer` (M5) on the Claude API. Needs the optional peer
dependency `@anthropic-ai/sdk`.

- `claude-client.ts`: `claudeClient`, the `ModelClient` (`../model-client.ts`)
  for Claude, in `'native'` output mode.
- `index.ts`: `claude = providerRoles(claudeClient)` (`../roles.ts`).

## Interface

- `claude.generator({ apiKey, model, effort?, maxRetries? })`,
  `claude.reviewer({ ... })` and `claude.optimizer({ ... })`. The optimizer
  sends no dictionary: it sees only code. The plan's example uses
  `claude-sonnet-5-5` at `effort: 'low'` to generate and to review.

## Invariants

- **`apiKey` is required.** Core passes it to the SDK and never reads
  `ANTHROPIC_API_KEY` itself.
- **Structured output.** `client.beta.messages.parse` with
  `output_config.format` built from the shared zod schema, so the reply is
  checked before anything runs.
- **Cached prefix.** The instructions plus the dictionary are the system
  prompt, cached with `cache_control`, so repeated generations pay for the
  dictionary once.
- **Refusal fallbacks.** For models that support server-side fallbacks
  (Fable 5.2/5.1, Opus 5.5/5, Sonnet 5.5), requests send the
  `server-side-fallback-2026-07-01` beta with `fallbacks: "default"`.
- **Error mapping:**
  - a refusal → `GENERATION_FAILED` (final);
  - an incomplete reply, or one that misses the schema → `GENERATION_FAILED` (retryable);
  - a bad key → `GENERATION_FAILED` (final);
  - a rate limit → `GENERATION_RATE_LIMITED` (retryable);
  - a timeout → `GENERATION_TIMEOUT` (retryable);
  - a 5xx → `GENERATION_FAILED` (retryable).
- **Request size.** `max_tokens` is 16 000 per request (non-streaming), and
  the timeout is the one the engine passes per call.

## Side Effects

- Calls the Claude API.

## Verification

- `test/models/claude.test.ts` runs the ModelClient contract against a
  stubbed `fetch`, and checks the request shape and the cached dictionary.
- `npm run bench` with `ANTHROPIC_API_KEY` for a real run.
