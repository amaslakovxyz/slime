# Repository contract

This file is the repository-level instruction source for every supported agent
runtime (Claude Code, etc.). This is a **hackathon** repo: favor fast iteration
over ceremony, but keep the few rules below that prevent lost work.

## Git workflow

- Direct commits to `main` are allowed (hackathon pace).
- When a change is risky or exploratory, use a short-lived branch
  (`feat/<short-name>` / `fix/<short-name>`) so `main` stays runnable.
- Keep one concern per commit where practical; write messages that say *why*.

## Pre-commit

- Pre-commit hooks must pass. Never use `--no-verify`.
- If a hook is broken, fix the hook in its own change rather than bypassing it.

## Working safely

- Preserve unrelated pre-existing changes. Do not stash, discard, or overwrite
  work you did not create as part of the current task.
- Verify documentation claims against the live configuration before trusting them.

## Documentation

- `README.md` is the repository map (add it once the project shape is known).
- Record non-obvious decisions as short inline rationale comments or notes.
