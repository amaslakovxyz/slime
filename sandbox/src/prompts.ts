// Prompt text and the generated-artifact schema, kept free of model-client imports
// so the engine can compute cache keys in locked mode without loading any client.
import { z } from 'zod';
import type { Provider } from './config.js';
import { sha256 } from './fingerprint.js';

export const ArtifactSchema = z.object({
  unsatisfiable: z.string().nullable(),
  sql: z.string(),
  params: z.array(z.string()),
  shapeJs: z.string().nullable(),
  assumptions: z.array(z.string()),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// Kept byte-stable: it is the cached prompt prefix, and its hash is part of every
// handler's cache key (editing it invalidates old handlers automatically).
export const INSTRUCTIONS = `You write read-only data handlers for Slime, a backend that answers frontend data requests.

You get a database schema, a request intent, the NAMES and TYPES of the input parameters (never their values), and the JSON output shape the caller wants. Return:
- unsatisfiable: null, or one sentence saying why the schema cannot answer the request (missing tables/columns, or the request asks to change data). If set, the other fields are ignored: use "" and [].
- sql: ONE PostgreSQL SELECT statement (a WITH ... SELECT is fine) that fetches what the output needs. No trailing semicolon.
- params: the input parameter name for each placeholder, in order: params[0] is $1, params[1] is $2.
- shapeJs: null when every SQL row already is one list item of the requested output (the output is a list of flat objects and the SQL column aliases are exactly the requested keys). Otherwise, JavaScript source that defines: function shape(rows, input) { ... return output; }
- assumptions: short notes on interpretations you made (for example how a vague term like "churn risk" was computed). [] if none.

SQL rules:
- Read only. Never write INSERT, UPDATE, DELETE, DDL, set_config, pg_sleep, or query system catalogs.
- Use input values only through $n placeholders with an explicit cast ($1::int, $2::timestamptz, $3::text). Never copy a value from the intent into the SQL; if the intent mentions a value that is not an input parameter, use a sensible default only when the intent clearly implies one.
- Do filtering, joins, aggregation, sorting and limits in SQL. ORDER BY whenever the order matters.
- Use only tables and columns listed in the schema.
- Return numbers as numbers: cast counts with ::int, money/averages with ::float8 or ROUND(x::numeric, 2)::float8.
- Return dates and timestamps that appear in the output as text, e.g. to_char(ts, 'YYYY-MM-DD').
- Alias columns with the exact output key names when shapeJs is null. Postgres lowercases unquoted names, so double-quote any alias with capitals: AS "revenueCents", never AS revenueCents.

shapeJs rules:
- Plain synchronous JavaScript (ES2020). Only standard built-ins (Array, Object, Math, String, Number, JSON, Date). No require, import, fetch, timers, or async.
- Use it for nesting, grouping into sub-lists, renaming and formatting. Keep it short.
- The returned value must match the output shape exactly: same keys, no extra keys.

Output shape notation: leaves are type names ("string", "number", "integer", "boolean", optionally "|null"); an array with one element means a list of that element; an object means exactly those keys.`;

// JSON mode only guarantees valid JSON, so the expected keys are spelled out here
// and replies are validated with the same zod schemas the Claude path uses.
export const ARTIFACT_FORMAT = `Reply with ONLY a JSON object with exactly these keys:
{"unsatisfiable": string or null, "sql": string, "params": string[], "shapeJs": string or null, "assumptions": string[]}`;
export const REVIEW_FORMAT = `Reply with ONLY a JSON object with exactly these keys:
{"verdict": "approve" or "reject", "problems": string[]}`;

/**
 * Part of every handler's cache key: editing the prompt (or switching provider)
 * gives new keys, so handlers generated under the old prompt are never reused.
 */
export function promptHashFor(provider: Provider): string {
  if (provider === 'groq') return sha256(`groq\n${INSTRUCTIONS}\n${ARTIFACT_FORMAT}`).slice(0, 16);
  return sha256(`${provider}\n${INSTRUCTIONS}`).slice(0, 16);
}
