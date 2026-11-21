// M4's live run: the built package against the demo Postgres with a real model, as
// generator and reviewer. Reads its settings from env (core itself never does).
//   GROQ_API_KEY=... npm run live -w @slime-cloud/core          (openai/gpt-oss-120b)
//   ANTHROPIC_API_KEY=... npm run live -w @slime-cloud/core     (claude-haiku-5-5 + claude-opus-5-5)
// Optional: DATABASE_URL (default: the demo database from sandbox/db/init.sql).
const ROOT = new URL('..', import.meta.url).pathname;
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const TOP_ACCOUNTS = { intent: 'top N accounts by total paid amount, highest first', output: [{ name: 'string', totalPaid: 'integer' }] };
const NEWEST_IN_COUNTRY = { intent: 'accounts in a country, newest first', output: [{ name: 'string', createdAt: 'date' }] };
const REQUESTS = [
  { ...TOP_ACCOUNTS, input: { limit: 3 } },
  { ...TOP_ACCOUNTS, input: { limit: 2 } },
  { ...NEWEST_IN_COUNTRY, input: { country: 'DE', limit: 2 } },
  { ...NEWEST_IN_COUNTRY, input: { country: null, limit: 2 } },
  { intent: 'number of accounts per plan', output: [{ plan: 'string', accounts: 'integer' }] },
];

const core = await import(`${ROOT}dist/index.js`);
const { postgresConnector } = await import(`${ROOT}dist/postgres/index.js`);
const models = await chooseModels();
const events = [];
const slime = await core.createSlime(
  new core.SlimeConfig({
    connector: postgresConnector({ url: DATABASE_URL }),
    ...models,
    store: core.memoryStore(),
    tiers: { gasToLiquidRuns: 2 },
    rules: ['Revenue counts only invoices with status paid.'],
    onEvent: (event) => events.push(event.type === 'generated' ? { type: event.type, sql: event.sql.replace(/\s+/g, ' ') } : event),
  }),
);

for (const request of REQUESTS) {
  try {
    const { data, meta } = await slime.query(request);
    console.log(JSON.stringify({ intent: request.intent, input: request.input, data, tier: meta.tier, cache: meta.cache, review: meta.review, timingsMs: meta.timingsMs }));
  } catch (error) {
    console.log(JSON.stringify({ intent: request.intent, input: request.input, error: `${error.code}: ${error.message}` }));
  }
}
await slime.flush();
console.log('events:', JSON.stringify(events, null, 1));
console.log('handlers:', JSON.stringify(slime.handlers().map(({ intent, tier, runs }) => ({ intent, tier, runs }))));
await slime.close();

async function chooseModels() {
  if (process.env.GROQ_API_KEY) {
    const { groq } = await import(`${ROOT}dist/groq/index.js`);
    const options = { apiKey: process.env.GROQ_API_KEY, model: 'openai/gpt-oss-120b' };
    return { generator: groq.generator({ ...options, reasoningEffort: 'low' }), reviewer: groq.reviewer({ ...options, reasoningEffort: 'high' }) };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const { claude } = await import(`${ROOT}dist/claude/index.js`);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    return { generator: claude.generator({ apiKey, model: 'claude-haiku-5-5' }), reviewer: claude.reviewer({ apiKey, model: 'claude-opus-5-5' }) };
  }
  throw new Error('Set GROQ_API_KEY or ANTHROPIC_API_KEY.');
}
