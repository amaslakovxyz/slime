// Speed + correctness benchmark. Talks to the engine directly (no HTTP), so the
// numbers are server-side. Usage: npm run bench [-- case_name ...]
import { cases, type BenchCase } from './bench-cases.js';
import { config } from './config.js';
import { PostgresConnector } from './connectors/postgres.js';
import { Engine, type QueryMeta } from './engine.js';
import { SlimeError } from './errors.js';
import { canonicalJSON } from './fingerprint.js';

const keyVar = config.provider === 'groq' ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY';
if (!process.env[keyVar]) {
  console.error(`${keyVar} is not set (SLIME_PROVIDER=${config.provider}). Copy .env.example to .env and add your key (see README).`);
  process.exit(1);
}

const only = process.argv.slice(2);
const selected = only.length ? cases.filter((c) => only.includes(c.name)) : cases;

const connector = new PostgresConnector(config.databaseUrl);
const engine = await Engine.create(connector);
const runSql = async (sql: string, params: unknown[]) => (await connector.run(sql, params)).rows;

console.log(
  `provider=${config.provider} model=${config.model} effort=${config.effort}` +
    `${config.provider === 'claude' ? ` thinking=${config.thinking ? 'on' : 'off'}` : ''} repairs<=${config.maxRepairs}\n`,
);

interface Row {
  case: string;
  result: string;
  attempts: number | string;
  'gas total ms': number | string;
  'model ms': number | string;
  'out tokens': number | string;
  'hit ms': number | string;
  'alt input': string;
  'rate-limit wait s': number | string;
}
const rows: Row[] = [];
const failures: string[] = [];

for (const c of selected) {
  rows.push(await runCase(c));
}

console.table(rows);
summarize(rows);
if (failures.length) console.log(`\nDetails:\n${failures.join('\n\n')}`);
await connector.close();

async function runCase(c: BenchCase): Promise<Row> {
  const req = { intent: c.intent, input: c.input, output: c.output };
  const row: Row = {
    case: c.name,
    result: '',
    attempts: '-',
    'gas total ms': '-',
    'model ms': '-',
    'out tokens': '-',
    'hit ms': '-',
    'alt input': '-',
    'rate-limit wait s': '-',
  };
  const started = performance.now();

  let first: { data: unknown; meta: QueryMeta };
  try {
    first = await engine.query(req);
  } catch (err) {
    const code = err instanceof SlimeError ? err.code : 'CRASH';
    row['gas total ms'] = Math.round(performance.now() - started);
    if (c.kind === 'refusal' && c.expectCodes.includes(code)) {
      row.result = `ok (refused: ${code})`;
    } else {
      row.result = `FAIL (${code})`;
      failures.push(`${c.name}: ${(err as Error).message}`);
    }
    return row;
  }

  const gen = first.meta.generation;
  row.attempts = gen?.attempts ?? '-';
  // Gas time excludes free-tier rate-limit waits, which are shown in their own column.
  row['gas total ms'] = Math.round(first.meta.timingsMs.total - (gen?.waitMs ?? 0));
  row['rate-limit wait s'] = gen?.waitMs ? Math.round(gen.waitMs / 1000) : 0;
  row['model ms'] = gen ? Math.round(gen.ms) : '-';
  row['out tokens'] = gen?.outputTokens ?? '-';

  if (c.kind === 'refusal') {
    row.result = 'FAIL (answered instead of refusing)';
    failures.push(`${c.name}: returned data. SQL:\n${first.meta.sql}`);
    return row;
  }

  // Same request again: must come from cache.
  const second = await engine.query(req);
  row['hit ms'] = Math.round(second.meta.timingsMs.total * 10) / 10;
  if (second.meta.cache !== 'hit') failures.push(`${c.name}: second identical request was a ${second.meta.cache}, not a hit`);

  if (c.kind === 'shape-only') {
    const nonEmpty = canonicalJSON(first.data).length > 20;
    row.result = nonEmpty ? 'ok (shape only)' : 'FAIL (empty)';
    if (!nonEmpty) failures.push(`${c.name}: empty result`);
    failures.push(`${c.name} (for review) assumptions: ${first.meta.assumptions.join(' | ') || 'none'}\nSQL:\n${first.meta.sql}`);
    return row;
  }

  const correct = await matches(c, first.data, c.input);
  row.result = correct ? 'ok' : 'WRONG';
  if (!correct) failures.push(`${c.name}: wrong answer.\nSQL:\n${first.meta.sql}\nshapeJs: ${first.meta.shapeJs}\nassumptions: ${first.meta.assumptions.join(' | ')}`);

  // Different input values: must still be a cache hit, and still correct.
  try {
    const alt = await engine.query({ ...req, input: c.altInput });
    const altCorrect = await matches(c, alt.data, c.altInput);
    row['alt input'] = `${alt.meta.cache}${altCorrect ? '' : ' WRONG'}`;
    if (!altCorrect) failures.push(`${c.name}: wrong answer for alt input ${JSON.stringify(c.altInput)}`);
  } catch (err) {
    row['alt input'] = `error ${(err as SlimeError).code ?? ''}`;
    failures.push(`${c.name} alt input: ${(err as Error).message}`);
  }
  return row;
}

async function matches(c: Extract<BenchCase, { kind: 'checked' }>, actual: unknown, input: Record<string, unknown>) {
  const expected = await c.expected(runSql, input);
  return normalize(actual, c.ordered) === normalize(expected, c.ordered);
}

// Compares values with numbers rounded to 2 decimals; nested lists are compared as
// sets, and the top-level list too unless the case says order matters.
function normalize(value: unknown, orderedTop: boolean, depth = 0): string {
  if (Array.isArray(value)) {
    const items = value.map((v) => normalize(v, orderedTop, depth + 1));
    if (!(orderedTop && depth === 0)) items.sort();
    return `[${items.join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${k}:${normalize(obj[k], orderedTop, depth + 1)}`).join(',')}}`;
  }
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  return JSON.stringify(value);
}

function summarize(all: Row[]) {
  const median = (xs: number[]) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const nums = (key: keyof Row) => all.map((r) => r[key]).filter((v): v is number => typeof v === 'number');
  const generated = all.filter((r) => typeof r.attempts === 'number');
  const ok = all.filter((r) => r.result.startsWith('ok')).length;
  const firstTry = generated.filter((r) => r.attempts === 1 && r.result.startsWith('ok')).length;
  console.log(
    [
      `passed: ${ok}/${all.length}`,
      `right on first try: ${firstTry}/${generated.length}`,
      `median Gas total: ${median(nums('gas total ms'))} ms`,
      `median model time: ${median(nums('model ms'))} ms`,
      `median output tokens: ${median(nums('out tokens'))}`,
      `median cache hit: ${median(nums('hit ms'))} ms`,
    ].join('\n'),
  );
}
