# dictionary

## Overview

The dictionary (PLAN.md §4.4) is the text every generation gets as context.
It is rendered from the database metadata (`Connector.describe()`), the
app's `glossary` and the app's `rules`. No model writes it (D2), and it is
not stored (D3): `createSlime()` builds it at every start.

## Interface

- `buildDictionary({ schema, glossary, rules }): Dictionary` (`dictionary.ts`)
  - `text`: database dialect, one block per table, the columns (type,
    nullability, primary key, `references`, enum values), then the glossary
    and the rules;
  - `hash`: `sha256(text)`, recorded in each handler's provenance;
  - `schemaHash`: `sha256(canonicalJSON(schema))`, recorded the same way.

## Invariants

- **Deterministic.** The same inputs give the same text and hashes.
- **Rules don't change `schemaHash`.** Glossary and rules change the text
  and `hash`, never `schemaHash`, so the Crystal startup warning only
  reacts to schema changes.
- **Empty sections are left out.**

## Side Effects

- None.

## Verification

- `test/dictionary/dictionary.test.ts`.
