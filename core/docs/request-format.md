# The request format

How an app asks `slime.query()` for data, and what it gets back. The design
reasons are in [PLAN.md](../PLAN.md) §4.

## A request

```json
{
  "intent": "top N accounts by total paid invoice amount in cents, highest first",
  "input": { "limit": 5, "country": null },
  "output": [{ "name": "string", "totalPaidCents": "integer" }]
}
```

| Field | Required | Rules |
|---|---|---|
| `intent` | yes | What you want, in words, at most 500 characters. Put values in `input`, not in the text. |
| `input` | no | Up to 20 parameters. Names: letters, digits and `_`, starting with a letter or `_`. Values: string, number, boolean, `null`, or a list of those. |
| `output` | yes | The shape of `data` you want back (below). |

Unknown fields are refused with `INVALID_REQUEST`.

## The handler cache

The first time Slime sees a request, a model writes a read-only SQL query and,
when needed, a JavaScript shaping function. Slime checks and runs them, then
keeps them as a **handler**. The cache key is:

- the intent, normalized for case, spacing, Unicode and trailing punctuation;
- the **names** in `input`;
- `output`.

Input values are never part of the key, so `{ limit: 5 }` and `{ limit: 50 }`
use the same handler. Rewording the intent, adding or removing a parameter,
or changing `output` makes a new handler.

A wrong answer is fixed by rewording the intent. In explore mode, the
generated SQL and the model's assumptions are in `meta` (below).

## Parameters

- **`null` means "not given".** A frontend with five optional filters sends
  all five names every time, with `null` for unused ones, and gets one
  handler. Leaving a name out is a different request.
- **Types are fixed by first use.** A parameter's type (`string`, `number`,
  `boolean` or `list`) is recorded from its first non-null value. A later
  value of another type is refused with `INVALID_REQUEST`. Whole and decimal
  numbers are the same type.
- **`limit` and `offset` page the top-level list.** They must be
  non-negative integers or `null`. A result with more rows than `limit` is a
  failed run.
- **Values in the intent get a warning.** A number, quoted text, an email or
  a UUID in the intent is reported in `meta.warnings`: such values belong in
  `input`, or the handler only works for that one value.

## Output notation

- **Leaves** are type names, each optionally followed by `|null`:
  - `"string"`, `"number"`, `"integer"`, `"boolean"`;
  - `"date"` (`YYYY-MM-DD`);
  - `"datetime"` (ISO 8601 with a time zone).
- **A list** is an array with one element: `[{ "name": "string" }]`.
- **An object** means exactly those keys.
- **At the top level,** a list means rows. An object means one row, and
  `data` is `null` when there is none.
- **Limits:** at most 6 levels deep and 50 fields.

Every result is checked against `output`: no missing keys, no extra keys, the
right types and date formats. A result that doesn't match fails with
`SHAPE_MISMATCH`.

## What comes back

`{ data, meta }`. `data` matches `output`. `meta` has:

| Field | Meaning |
|---|---|
| `handlerKey` | The handler's key (use it with `slime.evict()`). |
| `tier` | `gas` (new, in memory), `liquid` (saved) or `crystal` (code in your app). |
| `cache` | `miss` (generated now), `hit` or `coalesced` (shared a generation with a concurrent request). |
| `truncated` | `rowCap` cut the rows. |
| `timingsMs` | `total`, `run`, `shape`, and `generate` on a miss. |
| `warnings` | For example, a value written into the intent. |
| `review` | `none`, `pending`, `approved` or `rejected`. |
| `sql`, `shapeJs`, `assumptions` | **Explore mode only:** what was generated, and how the model read the intent. |

## Errors

Failures are thrown as `SlimeError`. Each has a `code`, a fixed HTTP
`status`, `retryable`, and `toJSON()` for a response body:

| Code | Status | When |
|---|---|---|
| `INVALID_REQUEST` | 400 | The request or an input value breaks the rules above. |
| `WRITE_REFUSED` | 403 | The request asks to change data, or the SQL tried to. |
| `ACCESS_DENIED` | 403 | The database user may not read a table or column. |
| `HANDLER_NOT_FOUND` | 404 | Locked mode, and no saved or Crystal handler matches. |
| `INTENT_UNSATISFIABLE` | 422 | The database can't answer this request. |
| `GENERATION_RATE_LIMITED` | 429 | The hourly generation limit, or the model provider's (retryable). |
| `SHAPE_MISMATCH` | 500 | The result doesn't match `output`. |
| `SANDBOX_ERROR` | 500 | The shaping function threw or ran too long. |
| `QUERY_ERROR` | 500 | The database rejected the SQL. |
| `QUERY_TOO_EXPENSIVE` | 500 | The planner cost is above `maxQueryCost`. |
| `INVALID_HANDLER` | 500 | Generated code failed a check (for example, more rows than `limit`). |
| `GENERATION_FAILED` | 502 | The model call failed. |
| `GENERATION_TIMEOUT` | 504 | Generation ran out of time (retryable). |
| `EXECUTION_TIMEOUT` | 504 | The query ran longer than `statementTimeoutMs` (retryable). |

```ts
try {
  res.json(await slime.query(request));
} catch (err) {
  if (err instanceof SlimeError) return res.status(err.status).json({ error: err.toJSON() });
  throw err;
}
```

## Multi-source handlers

When the config has API sources ([multi-source.md](./multi-source.md),
decisions MS1–MS17 in [PLAN.md §3.1](../PLAN.md)), handlers can read from
several sources. Nothing here applies while no API source is configured:
requests, handlers, `meta` and errors stay exactly as described above.

The request itself is unchanged: `{ intent, input, output }`. What changes is
the handler the model writes when the instance has at least one API source.

### The v2 artifact

```jsonc
{
  "version": 2,
  "unsatisfiable": null,                    // or one sentence on why the sources can't answer
  "steps": [
    { "name": "accounts", "source": "db",
      "sql": "SELECT … WHERE p.name = $1::text", "params": ["plan"] },
    { "name": "feedback", "source": "notion", "operation": "feedback.query",
      "args": [ { "param": "sentiment", "input": null, "value": "negative" },
                { "param": "createdFrom", "input": "since", "value": null } ] }
  ],
  "shapeJs": "function shape(data, input) { … }",   // or null with exactly one step
  "assumptions": ["Feedback is matched to accounts by exact account name."]
}
```

| Field | Rule |
|---|---|
| `version` | Always `2`. A stored artifact without it is v1. |
| `steps` | 1 to `maxSteps` (default 4). `name` is an identifier (`^[a-z][A-Za-z0-9]*$`), unique in the handler. |
| SQL step | `{ name, source, sql, params }`: `source` is the SQL source; `sql` and `params` follow today's rules. |
| API step | `{ name, source, operation, args }`: `operation` is one the source declares. |
| `args` | A list. Each entry is `{ param, input, value }` with exactly one of `input` and `value` non-null. `input` names a request input; `value` is a string, number or boolean matching the parameter's type and allowed values. Each `param` at most once. |
| `shapeJs` | `function shape(data, input)`, where `data` is `{ [stepName]: rows[] }`. Required with more than one step. |

Every object is closed: no keys beyond those listed. A v2 artifact whose only
step is SQL is turned into a v1 artifact before it first runs.

### `meta` additions

| Field | Meaning |
|---|---|
| `steps` | **Explore mode only:** one entry per step, `{ name, source, rows, ms }`, plus `sql` for a SQL step, or `operation` and `args` for an API step. |
| `sql` | For a v2 handler, the SQL steps joined with `\n-- step <name>\n`. |
| `timingsMs.run` | For a v2 handler, the wall time of all steps together. |
| `truncated` | For a single-step handler, as today. A multi-step handler with a truncated step fails instead (`QUERY_TOO_LARGE`). |

### New errors

| Code | Status | When |
|---|---|---|
| `SOURCE_ERROR` | 502 | An API source failed. `retryable` is true for 429, 5xx and timeouts, false for other 4xx. Details: `source`, `operation`, `status`, `attempts`. Secrets are redacted. |
| `QUERY_TOO_LARGE` | 422 | A step in a multi-step handler reached `rowCap`, so a combined answer would be wrong. Details: `step`. Not retryable; narrow the request. |

An input value whose type doesn't match the API parameter it is bound to is an
`INVALID_REQUEST`, checked on every run.

## Modes, and who may send what

- **Explore mode** (a `generator` is configured) generates handlers for new
  requests. Use it in development.
- **Locked mode** (no `generator`) serves only saved and Crystal handlers.
  Use it in production: there, intents act as named routes.
- **Never pass a client's request body straight to `query()`,** and never
  take authorization from `input`. A client can set any input value, or
  `null` to drop a filter. Each endpoint should choose its intent and
  `output`, and set identity values (account, user, tenant) on the server.

The [Express example](../../examples/express/) shows this setup.
