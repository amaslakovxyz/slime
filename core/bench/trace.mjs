// The trace: one request through miss, hit and a hit with other input, timed twice: by
// meta.timingsMs and by spans this script wraps around every port the engine calls
// (generator, reviewer, connector, sandbox). The two should agree, and total minus the
// named parts should be a few ms. Needs the demo database (examples/express: npm run db:up).
//   npm run trace -w @slime-cloud/core                              (a fake 800 ms model, no key)
//   TRACE_REPAIR=1 npm run trace -w @slime-cloud/core              (the fake's first SQL is broken)
//   ANTHROPIC_API_KEY=... npm run trace -w @slime-cloud/core       (Claude; SLIME_MODEL, SLIME_EFFORT)
//   GROQ_API_KEY=... npm run trace -w @slime-cloud/core            (Groq; SLIME_MODEL)
import { performance } from 'node:perf_hooks';

const core = await import('@slime-cloud/core');
const { postgresConnector } = await import('@slime-cloud/core/postgres');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const FAKE_MS = 800;
const BAR_WIDTH = 40;
const round = (ms) => Math.round(ms * 10) / 10;

let startedAt = 0;
let spans = [];
const since = () => performance.now() - startedAt;

async function span(name, attrs, work) {
  const entry = { name, start: since(), attrs };
  spans.push(entry);
  try {
    const result = await work(entry);
    entry.end = since();
    return result;
  } catch (error) {
    entry.end = since();
    entry.attrs = { ...attrs, error: `${error.code ?? ''} ${error.message}`.trim().slice(0, 120) };
    throw error;
  }
}

function tracedGenerator(inner) {
  return {
    model: inner.model,
    promptHash: inner.promptHash,
    generate: (request, options) =>
      span('llm.generate', { repair: Boolean(request.previous), budgetMs: Math.round(options.timeoutMs) }, async (entry) => {
        const result = await inner.generate(request, options);
        Object.assign(entry.attrs, { reportedMs: round(result.ms), waitMs: round(result.waitMs), tokens: result.inputTokens + result.outputTokens });
        return result;
      }),
  };
}

function tracedReviewer(inner) {
  return inner && { model: inner.model, review: (request, options) => span('llm.review', { background: true }, () => inner.review(request, options)) };
}

function tracedConnector(inner) {
  return new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === 'check') return (...args) => span('db.explain', {}, () => value.apply(target, args));
      if (prop === 'run') {
        return (...args) =>
          span('db.run', {}, async (entry) => {
            const result = await value.apply(target, args);
            entry.attrs.rows = result.rows.length;
            return result;
          });
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function tracedRunner(inner) {
  return {
    run: (job, limits, stats) => span('sandbox', {}, () => inner.run(job, limits, stats)),
    close: () => inner.close(),
  };
}

const SQL = `SELECT a.name, sum(i.amount_cents)::int AS "totalPaidCents"
FROM accounts a JOIN invoices i ON i.account_id = a.id AND i.status = 'paid'
GROUP BY a.id, a.name ORDER BY 2 DESC LIMIT $1::int`;
const GOOD = {
  version: 2,
  unsatisfiable: null,
  steps: [{ name: 'top', source: 'db', sql: SQL, params: ['limit'] }],
  shapeJs: 'function shape(data) { return data.top.map((row) => ({ name: row.name, totalPaidCents: row.totalPaidCents })) }',
  assumptions: [],
};
const BROKEN = { ...GOOD, steps: [{ ...GOOD.steps[0], sql: SQL.replace('amount_cents', 'amount_cent_typo') }] };

function fakeGenerator() {
  return {
    model: 'trace-fake',
    promptHash: 'trace-fake',
    async generate(request) {
      const callStartedAt = performance.now();
      await new Promise((resolve) => setTimeout(resolve, FAKE_MS));
      const artifact = process.env.TRACE_REPAIR === '1' && !request.previous ? BROKEN : GOOD;
      return { artifact, ms: performance.now() - callStartedAt, waitMs: 0, inputTokens: 0, outputTokens: 0 };
    },
  };
}

async function chooseModels() {
  if (process.env.ANTHROPIC_API_KEY) {
    const { claude } = await import('@slime-cloud/core/claude');
    const { ANTHROPIC_API_KEY: apiKey, SLIME_MODEL: model = 'claude-sonnet-5-5', SLIME_EFFORT: effort = 'low' } = process.env;
    return { label: `${model} (${effort})`, generator: claude.generator({ apiKey, model, effort }), reviewer: claude.reviewer({ apiKey, model, effort }) };
  }
  if (process.env.GROQ_API_KEY) {
    const { groq } = await import('@slime-cloud/core/groq');
    const options = { apiKey: process.env.GROQ_API_KEY, model: process.env.SLIME_MODEL ?? 'openai/gpt-oss-120b' };
    return { label: `groq ${options.model}`, generator: groq.generator({ ...options, reasoningEffort: 'low' }), reviewer: groq.reviewer({ ...options, reasoningEffort: 'high' }) };
  }
  return { label: `fake ${FAKE_MS} ms model${process.env.TRACE_REPAIR === '1' ? ', first attempt broken' : ''}`, generator: fakeGenerator(), reviewer: undefined };
}

const { label, generator, reviewer } = await chooseModels();
const events = [];
const startup = performance.now();
const slime = await core.createSlime(
  new core.SlimeConfig({
    connector: tracedConnector(postgresConnector({ url: DATABASE_URL })),
    generator: tracedGenerator(generator),
    ...(reviewer ? { reviewer: tracedReviewer(reviewer) } : {}),
    store: core.memoryStore(),
    tiers: { gasToLiquidRuns: 2 },
    onEvent: (event) => events.push({ at: since(), event }),
  }),
  { runner: tracedRunner(new core.QuickJSRunner()) },
);
console.log(`model: ${label}\ncreateSlime: ${round(performance.now() - startup)} ms\n`);

const request = {
  intent: process.env.TRACE_INTENT ?? 'top N accounts by total paid invoice amount in cents, highest first',
  input: { limit: 5 },
  output: [{ name: 'string', totalPaidCents: 'integer' }],
};
const runs = [
  ['miss', request],
  ['hit', request],
  ['hit, other input', { ...request, input: { limit: 10 } }],
];

for (const [title, body] of runs) {
  spans = [];
  events.length = 0;
  startedAt = performance.now();
  const outcome = await slime.query(body).then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  const wallMs = since();
  await slime.flush(); // a review started by this request finishes here, so its span prints
  print(title, wallMs, outcome);
}
await slime.close();

function print(title, wallMs, { result, error }) {
  console.log(`━━━ ${title} ━━━ wall ${round(wallMs)} ms`);
  const scale = Math.max(wallMs, ...spans.map((entry) => entry.end));
  for (const entry of spans) {
    const offset = ' '.repeat(Math.round((entry.start / scale) * BAR_WIDTH));
    const bar = '█'.repeat(Math.max(1, Math.round(((entry.end - entry.start) / scale) * BAR_WIDTH)));
    console.log(`  ${entry.name.padEnd(13)} +${String(round(entry.start)).padStart(7)} ${String(round(entry.end - entry.start)).padStart(7)} ms ${(offset + bar).padEnd(BAR_WIDTH + 1)} ${JSON.stringify(entry.attrs)}`);
  }
  for (const { at, event } of events) {
    const { type, ms, tokens, verdict, code } = event;
    console.log(`  event ${type.padEnd(9)} +${round(at)} ${JSON.stringify({ ms: ms === undefined ? undefined : round(ms), tokens, verdict, code })}`);
  }
  if (error) return console.log(`  ERROR ${error.code}: ${error.message}\n`);
  const { total, ...parts } = result.meta.timingsMs;
  const named = Object.values(parts).reduce((sum, ms) => sum + ms, 0);
  console.log(`  meta  ${result.meta.tier}/${result.meta.cache}${result.meta.attempts ? `, ${result.meta.attempts} attempt(s)` : ''}: ${JSON.stringify(result.meta.timingsMs)}`);
  console.log(`  total ${total} vs wall ${round(wallMs)}; unnamed (total minus parts) ${round(total - named)} ms\n`);
}
