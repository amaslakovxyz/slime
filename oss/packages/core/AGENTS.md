# Code rules for @slime-cloud/core

These rules apply to every change in `oss/packages/core/`, on top of the
repository [AGENTS.md](../../../AGENTS.md). The aim: names, types and small
functions explain the code, so comments are rarely needed.

## Comments

- Don't write a comment that repeats the name, the types or the code. If a
  function seems to need one to say *what* it does, rename it or split it.
- No JSDoc on a function whose name and signature already say what it does.
- Comment only the *why*: a non-obvious constraint, a security reason, or a
  trade-off. One line where possible.
- Link a plan decision with its ID only (`// R6`, `// C14, §4.7`), not a
  paraphrase of it. PLAN.md and the folder READMEs hold the explanation.
- File header: at most one line, and none when the file name says it.
- Interface fields: comment only what the name and type can't carry, such as
  units that aren't in the name or a non-obvious meaning (`cost` in planner
  units). `timeoutMs: number` needs no comment.

## Names

- Functions say what they do or return: `assertReadOnlySql`,
  `changedProvenance`, `parseRequest`. Booleans start with `is`, `has` or
  `can`.
- Variables say what they hold, with units in the name: `timeoutMs`,
  `rowCap`, `usedPlaceholders`, not `t`, `n`, `m`, `used`.
- Single-letter names only for a loop index or a one-line callback whose
  meaning is obvious from the collection (`tables.map((t) => t.name)`).
- No abbreviations other than common ones: `sql`, `id`, `url`, `json`, `ms`.

## Constants

- No magic values in logic. Regexes, limits, sizes, reserved names and error
  messages used more than once become named constants at the top of the
  file: `WRITE_SQL`, `MAX_INTENT`, `PAGING_PARAMS`.
- Fixed sets are `as const` arrays or objects, and their types are derived
  from them (`type Tier = (typeof TIERS)[number]`), so the list and the type
  can't drift apart.
- Exported object constants are frozen (`Object.freeze`).

## Types

- Every shape that crosses a function or module boundary gets a named
  `interface` (or a `type` for unions). No inline object types in exported
  signatures.
- More than three parameters, or two of the same type next to each other,
  become one options object with its own interface.
- No `any`. Take `unknown` and narrow it.

## Size

- One concern per file. Keep files under about 150 lines; split a file once
  it passes 200.
- Keep functions under about 30 lines and at one level of detail. Prefer
  early returns to nested `if`s, and extract a named helper instead of
  writing a comment above a block.

## Example

Instead of:

```ts
// collect every $n used in the SQL
const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
```

write:

```ts
const PLACEHOLDER = /\$(\d+)/g;

function placeholderNumbers(sql: string): Set<number> {
  return new Set([...sql.matchAll(PLACEHOLDER)].map(([, digits]) => Number(digits)));
}

const usedPlaceholders = placeholderNumbers(sql);
```

## Existing code

Apply these rules to the code a change touches. Don't reformat unrelated
files in the same commit; a cleanup gets its own commit.
