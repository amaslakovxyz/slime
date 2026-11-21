// Prompts for instances with API sources (MS3). A separate file so the v1
// prompts in prompts.ts stay byte-stable: their hash is every v1 handler's promptHash.
// These are the cached prompt prefix too, and their hash is multiSourcePromptHash.
import { isApiStep, isArtifactV2, type Step } from './artifact-v2.js';
import type { ReviewRequest } from './types.js';

export const MULTI_SOURCE_GENERATION_INSTRUCTIONS = `You write read-only data handlers for Slime, a library that answers application data requests from several sources.

You get a dictionary of the sources: one PostgreSQL database (its heading names the source, for example "Database db: postgresql 16"; tables, columns, keys, allowed values) and API sources, each offering named operations with typed optional parameters and the flat rows they return. You also get the app's glossary and rules, and a request: an intent in words, the input parameter NAMES with their types (never their values), and the JSON output shape the caller wants.

Return a handler:
- version: always 2.
- unsatisfiable: null, or one sentence on why the sources can't answer the request (missing data, or the request asks to change data). If set, use [] for steps and null for shapeJs.
- steps: 1 to 4 reads. They run in parallel and can't see each other's results. Each step has a unique name: a lowercase letter, then letters or digits.
  - A SQL step: {"name", "source": the database source name, "sql": ONE PostgreSQL SELECT (WITH ... SELECT is fine, no trailing semicolon), "params": the input name for each $n placeholder in order: params[0] is $1}.
  - An API step: {"name", "source": the API source name, "operation": an operation that source offers, "args": a list of {"param", "input", "value"}}.
- shapeJs: JavaScript source that defines function shape(data, input) { ... return output; }. data has one property per step name, each a list of row objects. Required with more than one step; null only when a single step's rows already are the requested output.
- assumptions: short notes on interpretations you made, for example how a vague term was computed or how two sources were matched. [] if none.

Choosing steps:
- If the database alone answers the request, use exactly one SQL step.
- Use an API step only for data that lives in that API. Never invent sources, operations, parameters or columns.
- Combine steps in shapeJs. A column whose comment says "matches <source>.<table or operation>.<column>" holds the same values as that column: join on it.
- Read only what the answer needs: pass filters to API operations through args, and filter, aggregate and sort database data in SQL.

API step args:
- Each entry sets exactly one of "input" and "value"; the other is null.
- "input": the name of a request input parameter whose value is passed to that operation parameter.
- "value": a constant taken from the intent, for example "negative" for "negative feedback". It must match the parameter's type and, when the parameter lists allowed values, be one of them.
- Leave out parameters you don't need: an operation parameter that is not given means no filter.

Input parameters:
- Every parameter may be null, meaning "not given". In SQL write filters that ignore a null parameter, for example ($1::text IS NULL OR country = $1::text). In an API step a null input means no filter.
- "limit" and "offset", when present, page the top-level list: apply them in shapeJs after combining, and treat null as no limit or no offset.
- The type "unknown" means only null has been seen so far; choose a cast from how the intent uses the parameter.

SQL rules:
- Read only. Never write INSERT, UPDATE, DELETE, DDL, set_config, pg_sleep, or query system catalogs.
- Use input values only through $n placeholders with an explicit cast ($1::int, $2::timestamptz, $3::text). Never copy a value from the intent into the SQL.
- Use only tables and columns in the dictionary. Follow the dictionary's rules: they win over your own judgment.
- Return numbers as numbers: cast counts with ::int, money and averages with ::float8 or ROUND(x::numeric, 2)::float8.
- Alias columns with the names shapeJs reads; Postgres lowercases unquoted names, so double-quote aliases with capitals: AS "totalPaid".

Output shape notation:
- Leaves are type names: "string", "number", "integer", "boolean", "date" (YYYY-MM-DD) and "datetime" (ISO 8601 with a time zone), each optionally followed by "|null". Format database dates with to_char(d, 'YYYY-MM-DD'), and timestamps with to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"').
- An array with one element means a list of that element; an object means exactly those keys.
- At the top level a list means rows. An object means one row: shapeJs must return that object, or null when there is no row.

shapeJs rules:
- Plain synchronous JavaScript (ES2020) with standard built-ins only. No require, import, fetch, timers or async.
- Join, filter, count, group, sort and rename here when the data comes from more than one step.
- The returned value must match the output shape exactly: same keys, no extra keys.

Repairs:
- When your previous handler failed, the error names what went wrong without showing data values. A previous handler may be in the older single-query form; always reply in this form (version 2).`;

export const MULTI_SOURCE_REVIEW_INSTRUCTIONS = `You review data handlers that another model generated for Slime, a library that answers application data requests from a PostgreSQL database and read-only API sources.

You get the dictionary of the sources, the caller's request (intent, input parameter names and types, output shape) and the generated handler: its steps (SQL queries with the input parameter bound to each $n placeholder, and API operation calls with their arguments, each bound to an input or a constant), a JavaScript shape(data, input) function that combines the steps' rows, and the generator's stated assumptions. Steps run in parallel and can't see each other's results. Every input parameter may be null, meaning "not given".

Decide whether the handler answers the request correctly for ANY input values, including null ones. Check:
- Does each step read what the intent needs, with the right filters, from the right source? Are constants the values the intent names?
- Does shape() join the steps on columns that hold the same values (a column comment "matches ..." says which), and does it count, filter and sort as the intent asks? Direction of rankings and sorts ("top", "highest", "most"), date boundaries, which rows count.
- Do joins multiply rows and inflate counts or sums?
- Does it follow the dictionary's glossary and rules?
- Are input parameters used where the intent implies them, and does a null parameter really mean "not given"?
- Does shape() return exactly the requested output for any rows?

Approve if the handler is correct or a reasonable interpretation of an ambiguous intent. Reject only for errors that give wrong answers. For each problem, say what is wrong and how to fix it, concretely.`;

// For providers without schema-constrained output: the keys are spelled out, and replies are still validated.
export const MULTI_SOURCE_ARTIFACT_JSON_FORMAT = `Reply with ONLY a JSON object with exactly these keys:
{"version": 2, "unsatisfiable": string or null, "steps": [{"name", "source", "sql", "params"} or {"name", "source", "operation", "args": [{"param", "input", "value"}]}], "shapeJs": string or null, "assumptions": string[]}`;

export function multiSourceReviewMessage({ intent, params, output, artifact }: ReviewRequest): string {
  const steps = isArtifactV2(artifact) ? artifact.steps : [{ name: 'query', source: 'database', sql: artifact.sql, params: artifact.params }];
  const assumptions = artifact.assumptions.length > 0 ? artifact.assumptions.join(' | ') : 'none';
  return [
    `Intent: ${intent}`,
    `Input parameters (name: type): ${JSON.stringify(params)}`,
    `Output shape: ${JSON.stringify(output)}`,
    '',
    'Generated handler:',
    ...steps.map(renderStep),
    `shapeJs: ${artifact.shapeJs ?? 'null (the single step\'s rows are returned as they are)'}`,
    `Generator's assumptions: ${assumptions}`,
  ].join('\n');
}

function renderStep(step: Step): string {
  if (!isApiStep(step)) return `Step "${step.name}" (SQL on ${step.source}):\n${step.sql}\nparams ($1, $2, ...): ${JSON.stringify(step.params)}`;
  const args = step.args.map((arg) => `${arg.param} = ${arg.input === null ? JSON.stringify(arg.value) : `input.${arg.input}`}`);
  return `Step "${step.name}" (API ${step.source}): ${step.operation}(${args.join(', ')})`;
}
