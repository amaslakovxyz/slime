// P3.4 (core/docs/multi-source-implementation.md): one live multi-source run
// through the real engine and prompts. Manual; not under test/, not in CI.
//
//   npm run build -w @slime-cloud/core
//   GROQ_API_KEY=... node core/bench/spikes/multi-source-live.mjs
//
// Needs the demo database (examples/express: npm run db:up). Notion is a fake
// source shaped like the planned feedback data source; the adapter comes in P5.
import { SlimeConfig, createSlime, memoryStore } from '../../dist/index.js';
import { postgresConnector } from '../../dist/connectors/postgres/index.js';
import { groq } from '../../dist/models/groq/index.js';
import { fakeApiSource } from '../../dist/testing/index.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://slime_reader:slime_reader@localhost:54329/slime';
const MODEL = 'openai/gpt-oss-120b';
if (!process.env.GROQ_API_KEY) throw new Error('Set GROQ_API_KEY');

const db = postgresConnector({ url: DATABASE_URL });
const accountNames = await enterpriseAccountNames(db);
const notion = fakeApiSource({
  name: 'notion',
  service: 'Notion API 2025-09-03 (read-only access)',
  operations: {
    'feedback.query': {
      description: 'Customer feedback entries, newest first',
      params: [
        { name: 'sentiment', type: 'string', values: ['positive', 'neutral', 'negative'] },
        { name: 'status', type: 'string', values: ['Open', 'Triaged', 'Done'] },
        { name: 'createdFrom', type: 'date' },
      ],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: true },
        { name: 'account', type: 'string', nullable: true, comment: 'matches db.accounts.name' },
        { name: 'sentiment', type: 'string', nullable: true, values: ['positive', 'neutral', 'negative'] },
        { name: 'status', type: 'string', nullable: true, values: ['Open', 'Triaged', 'Done'] },
        { name: 'created', type: 'date', nullable: true },
      ],
      primaryKey: ['id'],
      // Honours the filters it is given, like the real adapter will.
      rows: (args) => feedbackRows(accountNames).filter((row) => (args.sentiment == null || row.sentiment === args.sentiment) && (args.status == null || row.status === args.status)),
    },
  },
});

const events = [];
const options = { apiKey: process.env.GROQ_API_KEY, model: MODEL };
const config = new SlimeConfig({
  sources: { db, notion },
  generator: groq.generator({ ...options, reasoningEffort: 'medium' }),
  reviewer: groq.reviewer({ ...options, reasoningEffort: 'high' }),
  store: memoryStore(),
  glossary: { revenue: 'sum of paid invoices, in cents' },
  rules: ['Revenue counts only invoices with status paid.'],
  tiers: { gasToLiquidRuns: 1 },
  // A shared Groq key can be slow under its rate limit; this is a manual check, not a latency test.
  limits: { generationBudgetMs: 90_000, reviewTimeoutMs: 120_000 },
  onEvent: (event) => events.push(event),
});
const slime = await createSlime(config);
try {
  const request = {
    intent: 'accounts on a given plan with their total paid revenue in cents and their number of open negative feedback items, most open items first',
    input: { plan: 'Enterprise' },
    output: [{ name: 'string', paidCents: 'integer', openNegative: 'integer' }],
  };
  const { data, meta } = await slime.query(request);
  await slime.flush();
  const generated = events.find((event) => event.type === 'generated');
  console.log('=== handler steps\n' + JSON.stringify(generated?.steps, null, 2));
  console.log('=== shapeJs\n' + generated?.shapeJs);
  console.log('=== meta.steps\n' + JSON.stringify(meta.steps?.map(({ name, source, rows, operation, args }) => ({ name, source, rows, operation, args })), null, 2));
  console.log(`=== first rows (${data.length} total)\n` + JSON.stringify(data.slice(0, 5), null, 2));
  console.log('=== events: ' + events.map((event) => (event.type === 'reviewed' ? `reviewed(${event.verdict})` : event.type)).join(', '));
  console.log('=== stats: ' + JSON.stringify(slime.stats()));
} finally {
  await slime.close();
}

async function enterpriseAccountNames(connector) {
  const sql = "SELECT a.name FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE p.name = 'Enterprise' ORDER BY a.id LIMIT 8";
  return (await connector.run(sql, [], { timeoutMs: 2_000, rowCap: 100 })).rows.map((row) => row.name);
}

function feedbackRows(names) {
  return names.flatMap((account, index) => [
    ...Array.from({ length: index % 3 }, (_, n) => ({ id: `${index}-o${n}`, title: 'Export is slow', account, sentiment: 'negative', status: 'Open', created: '2026-11-01' })),
    { id: `${index}-d`, title: 'Fixed sync bug', account, sentiment: 'negative', status: 'Done', created: '2026-10-01' },
    { id: `${index}-p`, title: 'Love the dashboard', account, sentiment: 'positive', status: 'Open', created: '2026-10-20' },
  ]);
}
