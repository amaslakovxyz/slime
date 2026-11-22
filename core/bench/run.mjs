// The bench (M6): the built package against the demo database. Correctness of
// each case, cache hits for repeats and other values, and timings.
//   GROQ_API_KEY=... npm run bench -w @slime-cloud/core          (openai/gpt-oss-120b)
//   ANTHROPIC_API_KEY=... npm run bench -w @slime-cloud/core     (claude-haiku-5-5 + claude-sonnet-5-5 review)
// Claude models and effort, named as in platform/runtime: SLIME_MODEL (claude-haiku-5-5), SLIME_EFFORT (unset),
// SLIME_REVIEW_MODEL (claude-sonnet-5-5), SLIME_REVIEW_EFFORT (low).
// Optional: DATABASE_URL, BENCH_CASES (another case file, e.g. examples/shop/bench-cases.mjs), and case names to run only those.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// BENCH_CASES picks another case file (e.g. examples/shop/bench-cases.mjs), relative to where npm was run.
const casesUrl = process.env.BENCH_CASES
  ? pathToFileURL(resolve(process.env.INIT_CWD ?? process.cwd(), process.env.BENCH_CASES)).href
  : new URL('./cases.mjs', import.meta.url).href;
const { cases } = await import(casesUrl);

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const DECIMALS = 100;

// Imported by the package's own name, through exports, as an app would (needs `npm run build`).
const core = await import('@slime-cloud/core');
const { postgresConnector } = await import('@slime-cloud/core/postgres');
const only = process.argv.slice(2);
const selected = only.length > 0 ? cases.filter(({ name }) => only.includes(name)) : cases;
const { label, ...models } = await chooseModels();
const reviews = [];
const connector = postgresConnector({ url: DATABASE_URL });
const slime = await core.createSlime(
  // gasToLiquidRuns: 2 so repeats trigger the review and promotion within one run.
  new core.SlimeConfig({ connector, ...models, store: core.memoryStore(), tiers: { gasToLiquidRuns: 2 }, onEvent: (event) => event.type === 'reviewed' && reviews.push(event) }),
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
    const { groq } = await import('@slime-cloud/core/groq');
    const options = { apiKey: process.env.GROQ_API_KEY, model: 'openai/gpt-oss-120b' };
    return { label: 'groq openai/gpt-oss-120b', generator: groq.generator({ ...options, reasoningEffort: 'low' }), reviewer: groq.reviewer({ ...options, reasoningEffort: 'high' }) };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const { claude } = await import('@slime-cloud/core/claude');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const { SLIME_MODEL: model = 'claude-haiku-5-5', SLIME_EFFORT: effort, SLIME_REVIEW_MODEL: reviewModel = 'claude-sonnet-5-5', SLIME_REVIEW_EFFORT: reviewEffort = 'low' } = process.env;
    return {
      label: `${model}${effort ? ` (${effort})` : ''}, reviewed by ${reviewModel} (${reviewEffort})`,
      generator: claude.generator({ apiKey, model, ...(effort ? { effort } : {}) }),
      reviewer: claude.reviewer({ apiKey, model: reviewModel, effort: reviewEffort }),
    };
  }
  console.error('The bench measures a model: set GROQ_API_KEY or ANTHROPIC_API_KEY.');
  process.exit(1);
}
