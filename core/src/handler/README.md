# handler

## Overview

A handler as Slime stores and serves it: the model's artifact plus what the
engine learned running it.

- `record.ts`: `HandlerRecord`, `Tier`, `StoredTier`, `ReviewStatus`,
  `HANDLERS_NS` (the store namespace), and `recordFromStore`, the one way a
  saved record is read (it converts the legacy single-query artifact, MS3).
- `crystal.ts`: `CrystalHandler`, `CrystalRegistry` and `ShapeFunction`, the
  shipped form of a handler (C10); `../engine/crystal/` serves it.
- `fits-sources.ts`: `savedHandlerProblem`, why a saved handler with API steps
  no longer fits today's sources (MS14).

## Invariants

- **Read through `recordFromStore`.** Nothing past the store sees the legacy
  artifact form.
- **Types and pure functions only.** No I/O; the engine owns the cache, the
  lifecycle and the store writes.
