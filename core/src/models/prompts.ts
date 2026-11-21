// The prompts every model adapter shares, so a bench compares models, not prompts.
// Kept byte-stable: they are the cached prompt prefix, and their hash is each handler's promptHash.
import type { GenerationRequest, OptimizeRequest, ReviewRequest } from './types.js';
import { sha256 } from '../shared/hash.js';

export const GENERATION_INSTRUCTIONS = `You write read-only data handlers for Slime, a library that answers application data requests.

You get the database dictionary (tables, columns, keys, allowed values, the app's glossary and rules) and a request: an intent in words, the input parameter NAMES with their types (never their values), and the JSON output shape the caller wants. Return:
- unsatisfiable: null, or one sentence on why the database can't answer the request (missing tables or columns, or the request asks to change data). If set, use "" and [] for the other fields.
- sql: ONE PostgreSQL SELECT statement (WITH ... SELECT is fine). No trailing semicolon.
- params: the input parameter name for each placeholder, in order: params[0] is $1, params[1] is $2.
- shapeJs: null when the SQL rows already are the requested output (a list of flat objects whose keys are exactly the SQL column aliases). Otherwise JavaScript source that defines function shape(rows, input) { ... return output; }
- assumptions: short notes on interpretations you made, for example how a vague term was computed. [] if none.

Input parameters:
- Every parameter may be null, meaning "not given". Write filters that ignore a null parameter, for example ($1::text IS NULL OR country = $1::text).
- "limit" and "offset", when present, page the top-level list: use them for LIMIT and OFFSET, and treat null as no limit or no offset.
- The type "unknown" means only null has been seen so far; choose a cast from how the intent uses the parameter.

SQL rules:
- Read only. Never write INSERT, UPDATE, DELETE, DDL, set_config, pg_sleep, or query system catalogs.
- Use input values only through $n placeholders with an explicit cast ($1::int, $2::timestamptz, $3::text). Never copy a value from the intent into the SQL.
- Do filtering, joins, aggregation, sorting and limits in SQL. ORDER BY whenever the order matters.
- Use only tables and columns in the dictionary. Follow the dictionary's rules: they win over your own judgment.
- Return numbers as numbers: cast counts with ::int, money and averages with ::float8 or ROUND(x::numeric, 2)::float8.
- Keep values in the unit the column stores (amount_cents stays in cents) unless the intent or an output key names another unit. When an output key does not name its unit, or you convert one, say which unit in assumptions.
- Alias columns with the exact output key names when shapeJs is null. Postgres lowercases unquoted names, so double-quote aliases with capitals: AS "totalPaid".

Output shape notation:
- Leaves are type names: "string", "number", "integer", "boolean", "date" (YYYY-MM-DD) and "datetime" (ISO 8601 with a time zone), each optionally followed by "|null". Format dates in SQL with to_char(d, 'YYYY-MM-DD'), and timestamps with to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"').
- An array with one element means a list of that element; an object means exactly those keys.
- At the top level a list means rows. An object means one row: shapeJs must return that object, or null when there is no row.

shapeJs rules:
- Plain synchronous JavaScript (ES2020) with standard built-ins only. No require, import, fetch, timers or async.
- Use it for nesting, grouping into sub-lists, one-row outputs, renaming and formatting. Keep it short.
- The returned value must match the output shape exactly: same keys, no extra keys.`;

export const REVIEW_INSTRUCTIONS = `You review data handlers that another model generated for Slime, a library that answers application data requests with read-only SQL.

You get the database dictionary, the caller's request (intent, input parameter names and types, output shape) and the generated handler: a PostgreSQL query, the input parameter bound to each $n placeholder, an optional JavaScript shape(rows, input) function, and the generator's stated assumptions. Every input parameter may be null, meaning "not given".

Decide whether the handler answers the request correctly for ANY input values, including null ones. Check:
- Does the SQL compute what the intent asks? Direction of rankings and sorts ("top", "highest", "most at risk"), filters, date boundaries, which rows count.
- Does it follow the dictionary's glossary and rules?
- Are vague terms interpreted sensibly? A score named after an outcome (a risk, likelihood or priority) must increase as that outcome becomes more likely, and "top" must put the highest score first.
- Do joins multiply rows and inflate counts or sums?
- Are input parameters used where the intent implies them, and does a null parameter really mean "not given"?
- Does shape() return exactly the requested output for any rows?

Approve if the handler is correct or a reasonable interpretation of an ambiguous intent. Reject only for errors that give wrong answers. For each problem, say what is wrong and how to fix it, concretely.`;

export const OPTIMIZE_INSTRUCTIONS = `You convert a verified, read-only data handler into its Crystal form. Crystal code runs inside the application with no sandbox, so it must follow strict rules, and it must return exactly the same result as the original for every input.

You get the handler's PostgreSQL query (inputs bound as $1, $2, ...), the input parameter name for each placeholder, its JavaScript shaping function (or null when the SQL rows are the output), the JSON output shape, and the input names and types. Every input may be null, meaning "not given".

Return:
- sql: one PostgreSQL SELECT. Keep the same results, row order, rounding, null handling and filters.
- params: the input name for each $n placeholder, in order.
- shape: null when the SQL rows already are the output (a list of flat objects whose column aliases are exactly the output keys). Otherwise the source of exactly one function: function shape(rows, input) { ... }.
- notes: short notes on what you changed and why. [] if nothing.

Optimize where it is safe: fold renaming and simple formatting into SQL aliases so shape can be null, and drop work whose result is unused. Do not change what the handler means. If unsure, keep the original logic.

Rules for shape (anything else is refused):
- A plain synchronous function. No async, generators, classes or this.
- Only these globals: Math, Object.keys/values/entries/fromEntries, Array.isArray/from/of, JSON.stringify/parse, Number(...), Number.isInteger/isFinite/isNaN/parseFloat/parseInt, String(...), Boolean(...), new Date(...), Date.UTC/parse, new Map(), new Set(), Intl formatters, parseInt, parseFloat, isNaN, isFinite.
- Loops: only for...of and array methods (map, filter, reduce, ...). No while, do...while, for(;;), for...in or labels.
- No computed property access with a variable key (obj[key]); use a Map for grouping. obj[0] and obj["literal"] are fine.
- Never use constructor, prototype, __proto__ or defineProperty, and never assign to or delete properties of globals.`;

// For providers without schema-constrained output: the keys are spelled out, and replies are still validated.
export const ARTIFACT_JSON_FORMAT = `Reply with ONLY a JSON object with exactly these keys:
{"unsatisfiable": string or null, "sql": string, "params": string[], "shapeJs": string or null, "assumptions": string[]}`;
export const OPTIMIZED_JSON_FORMAT = `Reply with ONLY a JSON object with exactly these keys:
{"sql": string, "params": string[], "shape": string or null, "notes": string[]}`;
export const REVIEW_JSON_FORMAT = `Reply with ONLY a JSON object with exactly these keys:
{"verdict": "approve" or "reject", "problems": string[]}`;

export function generationMessage({ intent, params, output, previous }: GenerationRequest): string {
  const lines = [`Intent: ${intent}`, `Input parameters (name: type): ${JSON.stringify(params)}`, `Output shape: ${JSON.stringify(output)}`];
  if (previous) {
    lines.push('', `Your previous handler failed with: ${previous.error}`, `Previous handler: ${JSON.stringify(previous.artifact)}`, 'Return a corrected handler.');
  }
  return lines.join('\n');
}

export function reviewMessage({ intent, params, output, artifact }: ReviewRequest): string {
  const assumptions = artifact.assumptions.length > 0 ? artifact.assumptions.join(' | ') : 'none';
  return [
    `Intent: ${intent}`,
    `Input parameters (name: type): ${JSON.stringify(params)}`,
    `Output shape: ${JSON.stringify(output)}`,
    '',
    'Generated handler:',
    `SQL:\n${artifact.sql}`,
    `params ($1, $2, ...): ${JSON.stringify(artifact.params)}`,
    `shapeJs: ${artifact.shapeJs ?? 'null (rows are returned as they are)'}`,
    `Generator's assumptions: ${assumptions}`,
  ].join('\n');
}

export function optimizeMessage({ sql, params, shapeJs, output, paramTypes }: OptimizeRequest): string {
  return [
    `SQL:\n${sql}`,
    `params ($1, $2, ...): ${JSON.stringify(params)}`,
    `shape: ${shapeJs ?? 'null'}`,
    `Output shape: ${JSON.stringify(output)}`,
    `Input parameters (name: type): ${JSON.stringify(paramTypes)}`,
  ].join('\n');
}

/** A provider's prompt text, hashed: editing it regenerates handlers in explore mode (§4.7). */
export function promptHash(provider: string, ...texts: string[]): string {
  return sha256([provider, ...texts].join('\n')).slice(0, 16);
}
