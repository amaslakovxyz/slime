// P0.3 spike (core/docs/multi-source-implementation.md): can a model write a
// valid v2 multi-source handler with the planned schema? Not shipped, not in CI.
//
//   npm run build -w @slime-cloud/core
//   GROQ_API_KEY=... [ANTHROPIC_API_KEY=...] node core/bench/spikes/multi-source-prompt.mjs
//
// Needs the demo database (examples/express: npm run db:up). SQL steps run
// against it; API steps get canned rows, because the adapters don't exist yet.
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { groqClient } from '../../dist/models/groq/groq-client.js';
import { generationMessage } from '../../dist/models/prompts.js';
import { buildDictionary } from '../../dist/dictionary/dictionary.js';
import { postgresConnector } from '../../dist/connectors/postgres/index.js';
import { QuickJSRunner } from '../../dist/sandbox/quickjs/quickjs-runner.js';
import { validateData } from '../../dist/request/shape.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const CLAUDE_MODEL = 'claude-haiku-5-5';
const TIMEOUT_MS = 90_000;
const LIMITS = { timeoutMs: 2_000, rowCap: 1_000 };
const SHAPE_LIMITS = { timeoutMs: 500, memoryBytes: 32 * 1024 * 1024 };
const MAX_STEPS = 4;

// --- The planned v2 schema (P0.2), every object closed -----------------------

const SqlStep = z.strictObject({ name: z.string(), source: z.string(), sql: z.string(), params: z.array(z.string()) });
const ApiArg = z.strictObject({
  param: z.string(),
  input: z.string().nullable(),
  value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
});
const ApiStep = z.strictObject({ name: z.string(), source: z.string(), operation: z.string(), args: z.array(ApiArg) });
const ArtifactV2Schema = z.strictObject({
  version: z.literal(2),
  unsatisfiable: z.string().nullable(),
  steps: z.array(z.union([SqlStep, ApiStep])),
  shapeJs: z.string().nullable(),
  assumptions: z.array(z.string()),
});

// --- Draft instructions (P3.1 refines them) ----------------------------------

const INSTRUCTIONS = `You write read-only data handlers for Slime, a library that answers application data requests from several sources.

You get a dictionary of the sources: one PostgreSQL database (tables, columns, keys, allowed values) and API sources, each offering named operations with typed optional parameters and the flat rows they return. You also get a request: an intent in words, the input parameter NAMES with their types (never their values), and the JSON output shape the caller wants.

Return a handler:
- version: always 2.
- unsatisfiable: null, or one sentence on why the sources can't answer the request (missing data, or the request asks to change data). If set, use [] for steps and null for shapeJs.
- steps: 1 to ${MAX_STEPS} reads that run in parallel and independently. Each step has a unique name (lowercase letter, then letters or digits).
  - A SQL step: { "name", "source": the database source name, "sql": ONE PostgreSQL SELECT, "params": the input name for each $n placeholder in order }.
  - An API step: { "name", "source": the API source name, "operation": an operation that source offers, "args": a list of { "param", "input", "value" } }.
- shapeJs: JavaScript source that defines function shape(data, input) { ... return output; }. data is an object with one property per step name, each a list of row objects. Required when there is more than one step; null only when a single step's rows already are the requested output.
- assumptions: short notes on interpretations you made. [] if none.

Choosing steps:
- If the database alone answers the request, use exactly one SQL step.
- Use an API step only for data that lives in that API. Never invent operations, parameters or columns.
- Steps can't see each other's results; combine them in shapeJs. Columns whose comment says "matches <source>.<table or operation>.<column>" hold the same values as that column and are the way to join.

API step args:
- Each entry sets exactly one of "input" and "value"; the other is null.
- "input": the name of a request input parameter whose value is passed to that operation parameter.
- "value": a constant taken from the intent (for example "negative" for "negative feedback"). It must match the parameter's type and one of its allowed values when it lists them.
- Leave out parameters you don't need; an operation parameter that is not given means "no filter".

SQL rules:
- Read only. Never write INSERT, UPDATE, DELETE, DDL, set_config, pg_sleep, or query system catalogs.
- Use input values only through $n placeholders with an explicit cast ($1::int, $2::text). Every input may be null, meaning "not given": write ($1::text IS NULL OR column = $1::text).
- Do filtering, joins, aggregation and sorting in SQL for database data. Return numbers as numbers (::int, ::float8).
- Alias columns with the names shapeJs will read; double-quote aliases with capitals.

shapeJs rules:
- Plain synchronous JavaScript (ES2020) with standard built-ins only. No require, import, fetch, timers or async.
- Join, filter, count, sort and rename here when the data comes from more than one step.
- The returned value must match the output shape exactly: same keys, no extra keys. "date" is YYYY-MM-DD, "datetime" is ISO 8601.`;

const JSON_FORMAT = `Reply with ONLY a JSON object with exactly these keys:
{"version": 2, "unsatisfiable": string or null, "steps": [ {"name", "source", "sql", "params"} or {"name", "source", "operation", "args": [{"param", "input", "value"}]} ], "shapeJs": string or null, "assumptions": string[]}`;

// --- API sources as the planned dictionary renders them (design §3.4) --------

const API_SOURCES = {
  notion: {
    service: 'Notion API 2025-09-03 (read-only access)',
    operations: {
      'feedback.query': {
        description: 'Customer feedback entries, newest first',
        params: [
          { name: 'sentiment', type: 'string', values: ['positive', 'neutral', 'negative'] },
          { name: 'status', type: 'string', values: ['Open', 'Triaged', 'Done'] },
          { name: 'createdFrom', type: 'date' },
          { name: 'createdTo', type: 'date' },
        ],
        columns: [
          ['id', 'string', false, 'primary key'],
          ['title', 'string', true],
          ['account', 'string', true, null, 'matches db.accounts.name'],
          ['sentiment', 'string', true, 'one of: positive, neutral, negative'],
          ['status', 'string', true, 'one of: Open, Triaged, Done'],
          ['area', 'string', true, null, 'option names joined with ", "'],
          ['created', 'date', true],
        ],
      },
      'movieNights.query': {
        description: 'Movie nights, newest first',
        params: [
          { name: 'host', type: 'string', values: ['Anna', 'Ben', 'Chen'] },
          { name: 'dateFrom', type: 'date' },
          { name: 'dateTo', type: 'date' },
        ],
        columns: [
          ['id', 'string', false, 'primary key'],
          ['film', 'string', true, null, 'matches films.films.list.title'],
          ['host', 'string', true, 'one of: Anna, Ben, Chen'],
          ['date', 'date', true],
          ['rating', 'number', true],
        ],
      },
    },
  },
  films: {
    service: 'Studio Ghibli API (public, read-only)',
    operations: {
      'films.list': {
        description: 'Studio Ghibli feature films',
        params: [{ name: 'director', type: 'string', comment: 'exact director name' }],
        columns: [
          ['id', 'string', false, 'primary key'],
          ['title', 'string', false],
          ['director', 'string', false],
          ['releaseYear', 'integer', false],
          ['runningTimeMin', 'integer', false],
          ['rtScore', 'integer', false],
        ],
      },
    },
  },
};

function renderApiSources() {
  return Object.entries(API_SOURCES)
    .map(([sourceName, source]) => {
      const lines = [`API source ${sourceName}: ${source.service}`];
      for (const [operationName, operation] of Object.entries(source.operations)) {
        lines.push(`Operation ${operationName}: ${operation.description}`, '  params (all optional; null = not given):');
        for (const param of operation.params) {
          const extras = [param.values ? `one of: ${param.values.join(', ')}` : null].filter(Boolean).join(' ');
          lines.push(`    ${param.name} ${param.type}${extras ? ` ${extras}` : ''}${param.comment ? ` -- ${param.comment}` : ''}`);
        }
        lines.push('  returns rows:');
        for (const [name, type, nullable, extra, comment] of operation.columns) {
          lines.push(`    ${name} ${type} ${nullable ? 'null' : 'not null'}${extra ? ` ${extra}` : ''}${comment ? ` -- ${comment}` : ''}`);
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

// Canned API rows for running shape; account names are filled from the database.
function cannedRows(accountNames) {
  return {
    'feedback.query': accountNames.flatMap((account, index) => [
      { id: `f${index}a`, title: 'Export is slow', account, sentiment: 'negative', status: 'Open', area: 'Performance', created: '2026-11-01' },
      { id: `f${index}b`, title: 'Love the dashboard', account, sentiment: 'positive', status: 'Done', area: 'UI', created: '2026-10-20' },
    ]),
    'movieNights.query': [
      { id: 'm1', film: 'My Neighbor Totoro', host: 'Anna', date: '2026-11-14', rating: 4.5 },
      { id: 'm2', film: 'Spirited Away', host: 'Ben', date: '2026-11-07', rating: 5 },
    ],
    'films.list': [
      { id: 'g1', title: 'My Neighbor Totoro', director: 'Hayao Miyazaki', releaseYear: 1988, runningTimeMin: 86, rtScore: 93 },
      { id: 'g2', title: 'Spirited Away', director: 'Hayao Miyazaki', releaseYear: 2001, runningTimeMin: 124, rtScore: 97 },
      { id: 'g3', title: 'Grave of the Fireflies', director: 'Isao Takahata', releaseYear: 1988, runningTimeMin: 89, rtScore: 97 },
    ],
  };
}

const INTENTS = [
  {
    label: '1 db + notion',
    intent: 'accounts on a given plan with their total paid revenue in cents and their number of open negative feedback items, most open items first',
    params: { plan: 'string' },
    input: { plan: 'Enterprise' },
    output: [{ name: 'string', paidCents: 'integer', openNegative: 'integer' }],
    expectedSources: ['db', 'notion'],
  },
  {
    label: '2 notion + films',
    intent: "movie nights with each film's director and running time in minutes, newest first",
    params: {},
    input: {},
    output: [{ film: 'string', date: 'date', director: 'string', runningTimeMin: 'integer' }],
    expectedSources: ['notion', 'films'],
  },
  {
    label: '3 films',
    intent: 'films by a given director with their Rotten Tomatoes score, highest first',
    params: { director: 'string' },
    input: { director: 'Hayao Miyazaki' },
    output: [{ title: 'string', rtScore: 'integer' }],
    expectedSources: ['films'],
  },
];

// --- A minimal version of the planned step lint (P2.5) -----------------------

const STEP_NAME = /^[a-z][A-Za-z0-9]*$/;

function lintProblems(artifact, inputNames) {
  const problems = [];
  if (artifact.unsatisfiable) return [`unsatisfiable: ${artifact.unsatisfiable}`];
  if (artifact.steps.length < 1 || artifact.steps.length > MAX_STEPS) problems.push(`${artifact.steps.length} steps`);
  const names = new Set();
  for (const step of artifact.steps) {
    if (!STEP_NAME.test(step.name) || names.has(step.name)) problems.push(`bad or duplicate step name ${step.name}`);
    names.add(step.name);
    if ('sql' in step) {
      if (step.source !== 'db') problems.push(`SQL step ${step.name} on source ${step.source}`);
      for (const param of step.params) if (!inputNames.includes(param)) problems.push(`SQL param ${param} is not an input`);
      continue;
    }
    const operation = API_SOURCES[step.source]?.operations[step.operation];
    if (!operation) {
      problems.push(`unknown operation ${step.source}.${step.operation}`);
      continue;
    }
    for (const arg of step.args) {
      const declared = operation.params.find((param) => param.name === arg.param);
      if (!declared) problems.push(`${step.name}: unknown param ${arg.param}`);
      if ((arg.input === null) === (arg.value === null)) problems.push(`${step.name}.${arg.param}: needs exactly one of input and value`);
      if (arg.input !== null && !inputNames.includes(arg.input)) problems.push(`${step.name}.${arg.param}: input ${arg.input} is not an input`);
      if (arg.value !== null && declared?.values && !declared.values.includes(arg.value)) problems.push(`${step.name}.${arg.param}: ${arg.value} not allowed`);
    }
  }
  if (artifact.steps.length > 1 && !artifact.shapeJs) problems.push('more than one step but no shapeJs');
  return problems;
}

// --- Running a handler: SQL against the demo database, API steps canned ------

async function runHandler({ artifact, input, output, connector, runner, canned }) {
  const data = {};
  for (const step of artifact.steps) {
    if ('sql' in step) {
      const result = await connector.run(step.sql, step.params.map((name) => input[name] ?? null), LIMITS);
      data[step.name] = result.rows;
    } else {
      data[step.name] = canned[step.operation] ?? [];
    }
  }
  const single = artifact.steps.length === 1 ? data[artifact.steps[0].name] : undefined;
  const result = artifact.shapeJs ? await runner.run({ code: artifact.shapeJs, rows: data, input }, SHAPE_LIMITS) : single;
  return { result, mismatches: validateData(output, result) };
}

// --- Claude: does the schema convert to a closed structured-output format? ---

function claudeSchemaCheck() {
  const format = betaZodOutputFormat(ArtifactV2Schema);
  const openObjects = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' && node.additionalProperties !== false) openObjects.push(path || '(root)');
    for (const [key, child] of Object.entries(node)) walk(child, `${path}/${key}`);
  };
  walk(format.schema, '');
  return { openObjects, schema: format.schema };
}

// --- Main -------------------------------------------------------------------

const clients = [];
if (process.env.GROQ_API_KEY) clients.push(groqClient({ apiKey: process.env.GROQ_API_KEY, model: GROQ_MODEL, reasoningEffort: 'medium' }));
if (process.env.ANTHROPIC_API_KEY) {
  const { claudeClient } = await import('../../dist/models/claude/claude-client.js');
  clients.push(claudeClient({ apiKey: process.env.ANTHROPIC_API_KEY, model: CLAUDE_MODEL }));
}

const claudeCheck = claudeSchemaCheck();
console.log(`Claude structured output: ${claudeCheck.openObjects.length === 0 ? 'every object is closed' : `OPEN objects at ${claudeCheck.openObjects.join(', ')}`}`);
if (clients.length === 0) {
  console.log('No GROQ_API_KEY or ANTHROPIC_API_KEY: nothing else to run.');
  process.exit(0);
}

const connector = postgresConnector({ url: DATABASE_URL });
const runner = new QuickJSRunner();
const dictionary = buildDictionary({ schema: await connector.describe(), glossary: { revenue: 'sum of paid invoices, in cents' }, rules: ['Revenue counts only invoices with status paid.'] });
// With API sources the database heading must carry the source name; run 1
// without it made the model use "postgresql" as the source (P1.5 finding).
const context = `${dictionary.text.replace(/^Database: /, 'Database db: ')}\n\n${renderApiSources()}`;
const accountNames = (await connector.run("SELECT a.name FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE p.name = 'Enterprise' ORDER BY a.id LIMIT 6", [], LIMITS)).rows.map((row) => row.name);
const canned = cannedRows(accountNames);

const summary = [];
for (const client of clients) {
  const instructions = client.outputMode === 'prompt' ? `${INSTRUCTIONS}\n\n${JSON_FORMAT}` : INSTRUCTIONS;
  for (const testCase of INTENTS) {
    const row = { provider: `${client.provider}/${client.model}`, intent: testCase.label, schema: '-', lint: '-', sources: '-', run: '-', ms: '-' };
    const startedAt = performance.now();
    try {
      const reply = await client.call({ instructions, context, message: generationMessage({ intent: testCase.intent, params: testCase.params, output: testCase.output }), schema: ArtifactV2Schema, timeoutMs: TIMEOUT_MS, label: 'spike' });
      row.ms = Math.round(performance.now() - startedAt);
      row.schema = 'ok';
      const artifact = reply.value;
      const problems = lintProblems(artifact, Object.keys(testCase.params));
      row.lint = problems.length === 0 ? 'ok' : problems.join('; ');
      const usedSources = [...new Set(artifact.steps.map((step) => step.source))].sort();
      row.sources = `${usedSources.join('+') || 'none'}${usedSources.join() === [...testCase.expectedSources].sort().join() ? '' : ' (expected ' + testCase.expectedSources.join('+') + ')'}`;
      if (problems.length === 0) {
        const { result, mismatches } = await runHandler({ artifact, input: testCase.input, output: testCase.output, connector, runner, canned });
        row.run = mismatches.length === 0 ? `ok (${Array.isArray(result) ? result.length : 1} rows)` : `shape: ${mismatches.slice(0, 2).join('; ')}`;
      }
      console.log(`\n=== ${row.provider} · intent ${testCase.label}\n${JSON.stringify(artifact, null, 2)}`);
    } catch (error) {
      row.ms = Math.round(performance.now() - startedAt);
      row.schema = `error: ${error.code ?? ''} ${String(error.message).slice(0, 160)}`;
    }
    summary.push(row);
  }
}

console.log('\n=== Summary');
console.table(summary);
await runner.close();
await connector.close();
