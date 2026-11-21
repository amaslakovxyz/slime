// The bench (M6): the built package against the demo database. Correctness of
// each case, cache hits for repeats and other values, and timings.
//   GROQ_API_KEY=... npm run bench -w @slime-cloud/core          (openai/gpt-oss-120b)
//   ANTHROPIC_API_KEY=... npm run bench -w @slime-cloud/core     (claude-haiku-5-5 + claude-opus-5-5 review)
//   npm run bench -w @slime-cloud/core                           (offline handlers: checks the bench, not a model)
// Optional: DATABASE_URL, and case names to run only those.
import { readFileSync } from 'node:fs';
import { cases } from './cases.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OFFLINE_HANDLERS = new URL('../../../examples/express/offline-handlers.json', import.meta.url).pathname;
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const DECIMALS = 100;

const core = await import(`${ROOT}dist/index.js`);
const { postgresConnector } = await import(`${ROOT}dist/postgres/index.js`);
const only = process.argv.slice(2);
const selected = only.length > 0 ? cases.filter(({ name }) => only.includes(name)) : cases;
const { label, ...models } = await chooseModels();
const reviews = [];
const connector = postgresConnector({ url: DATABASE_URL });
const slime = await core.createSlime(
  new core.SlimeConfig({ connector, ...models, store: core.memoryStore(), onEvent: (event) => event.type === 'reviewed' && reviews.push(event) }),
);
const referenceConnector = postgresConnector({ url: DATABASE_URL });
const runSql = async (sql, params) => (await referenceConnector.run(sql, params, { timeoutMs: 5_000, rowCap: 10_000 })).rows;

console.log(`bench: ${label}\n`);
const rows = [];
for (const benchCase of selected) rows.push(await runCase(benchCase));
console.table(rows);
await slime.flush();
if (reviews.length > 0) console.table(reviews.map(({ handlerKey, verdict, notes }) => ({ handler: handlerKey.slice(0, 12), verdict, notes })));
const passed = rows.filter(({ result }) => result.startsWith('ok')).length;
console.log(`passed: ${passed}/${rows.length}`);
await slime.close();
await referenceConnector.close();

async function runCase(benchCase) {
  const request = { intent: benchCase.intent, input: benchCase.input, output: benchCase.output };
  const row = { case: benchCase.name, result: '', 'first ms': '-', 'model ms': '-', 'hit ms': '-', 'other input': '-' };
  let first;
  try {
    first = await slime.query(request);
  } catch (error) {
    const isExpectedRefusal = benchCase.kind === 'refusal' && benchCase.expectedCodes.includes(error.code);
    return { ...row, result: isExpectedRefusal ? `ok (refused: ${error.code})` : `FAIL (${error.code ?? error.message})` };
  }
  Object.assign(row, { 'first ms': round(first.meta.timingsMs.total), 'model ms': round(first.meta.timingsMs.generate ?? 0) });
  if (benchCase.kind === 'refusal') return { ...row, result: 'FAIL (answered instead of refusing)' };

  const repeat = await slime.query(request);
  row['hit ms'] = `${round(repeat.meta.timingsMs.total)} (${repeat.meta.cache})`;
  if (benchCase.kind === 'shape-only') return { ...row, result: JSON.stringify(first.data).length > 20 ? 'ok (shape only)' : 'FAIL (empty)' };

  const isCorrect = await matches(benchCase, first.data, benchCase.input);
  const other = await slime.query({ ...request, input: benchCase.altInput }).catch((error) => ({ error }));
  row['other input'] = other.error ? `error ${other.error.code}` : `${other.meta.cache}${(await matches(benchCase, other.data, benchCase.altInput)) ? '' : ' WRONG'}`;
  return { ...row, result: isCorrect ? 'ok' : 'WRONG' };
}

async function matches(benchCase, actual, input) {
  const expected = await benchCase.expected(runSql, input);
  return normalized(actual, benchCase.isOrdered) === normalized(expected, benchCase.isOrdered);
}

// Numbers rounded to 2 decimals; nested lists compared as sets, and the top-level list too unless order matters.
function normalized(value, isOrderedAtTop, depth = 0) {
  if (Array.isArray(value)) {
    const items = value.map((item) => normalized(item, isOrderedAtTop, depth + 1));
    if (!(isOrderedAtTop && depth === 0)) items.sort();
    return `[${items.join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${key}:${normalized(value[key], isOrderedAtTop, depth + 1)}`).join(',')}}`;
  }
  return typeof value === 'number' ? String(round(value)) : JSON.stringify(value);
}

function round(ms) {
  return Math.round(ms * DECIMALS) / DECIMALS;
}

async function chooseModels() {
  if (process.env.GROQ_API_KEY) {
    const { groq } = await import(`${ROOT}dist/groq/index.js`);
    const options = { apiKey: process.env.GROQ_API_KEY, model: 'openai/gpt-oss-120b' };
    return { label: 'groq openai/gpt-oss-120b', generator: groq.generator({ ...options, reasoningEffort: 'low' }), reviewer: groq.reviewer({ ...options, reasoningEffort: 'high' }) };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const { claude } = await import(`${ROOT}dist/claude/index.js`);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    return { label: 'claude-haiku-5-5, reviewed by claude-opus-5-5', generator: claude.generator({ apiKey, model: 'claude-haiku-5-5' }), reviewer: claude.reviewer({ apiKey, model: 'claude-opus-5-5' }) };
  }
  const { offlineGenerator } = await import(`${ROOT}dist/offline/index.js`);
  return { label: 'offline handlers (no model)', generator: offlineGenerator(JSON.parse(readFileSync(OFFLINE_HANDLERS, 'utf8'))) };
}
