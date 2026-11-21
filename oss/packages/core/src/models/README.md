# models

## Overview

What the model adapters (`../claude/`, `../groq/`) share, so a bench
compares models, not prompts.

- `prompts.ts`: the generation, review and Crystal optimizer instructions,
  the JSON reply formats for providers without schema-constrained output,
  the user messages built from a request, and `promptHash()`.
- `schemas.ts`: the zod schemas a reply must match: `ArtifactSchema`,
  `ReviewVerdictSchema` and `OptimizedCodeSchema`.

## Interface

Internal: only the adapters import this folder, so the main entry never
loads `zod` schemas or prompt text it doesn't need.

## Invariants

- **The prompts follow the request format (§4):**
  - every parameter may be `null`, meaning "not given";
  - `limit` and `offset` page the top-level list;
  - the type `unknown` means only `null` has been seen;
  - `date` and `datetime` leaves;
  - a top-level object is one row, and `shapeJs` returns it or `null`;
  - the dictionary's rules win over the model's own judgment.
- **Byte-stable.** The prompt text is the cached prompt prefix, and
  `promptHash(provider, ...texts)` (16 hex characters) is recorded in every
  handler. Editing a prompt regenerates handlers in explore mode.
- **Never values or rows.** A model sees parameter names and types, never
  input values or rows.

## Side Effects

- None.

## Verification

- `test/groq.test.ts` checks the prompt and message a provider receives.
