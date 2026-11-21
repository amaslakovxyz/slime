# claude

## Overview

The `@slime-cloud/core/claude` entry (PLAN.md C7, M4): a `Generator` and a
`Reviewer` on the Claude API. Needs the optional peer dependency
`@anthropic-ai/sdk`.

- `structured-call.ts`: one Claude request whose reply is parsed and checked
  against a zod schema.
- `claude-models.ts`: `claudeGenerator` and `claudeReviewer`.

## Interface

- `claude.generator({ apiKey, model, effort?, maxRetries? })` and
  `claude.reviewer({ ... })` (also exported as `claudeGenerator`,
  `claudeReviewer`). The plan's example uses `claude-haiku-5-5` to generate
  and `claude-opus-5-5` to review.

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
  - an incomplete reply → `GENERATION_FAILED` (retryable);
  - a bad key → `GENERATION_FAILED` (final);
  - a rate limit → `GENERATION_RATE_LIMITED` (retryable);
  - a timeout → `GENERATION_TIMEOUT` (retryable);
  - a 5xx → `GENERATION_FAILED` (retryable).
- **Request size.** `max_tokens` is 16 000 per request (non-streaming), and
  the timeout is the one the engine passes per call.

## Side Effects

- Calls the Claude API.

## Verification

- `scripts/live-run.mjs` with `ANTHROPIC_API_KEY`. There is no offline test
  of this adapter; the engine tests use stub models.
