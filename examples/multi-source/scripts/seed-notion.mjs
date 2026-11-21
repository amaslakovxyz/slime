// P5.5: creates the two demo data sources under NOTION_PARENT_PAGE_ID and fills
// them, using the seeder integration (Insert content). Slime itself only ever
// uses the reader token. Prints the ids to put into .env.
//
//   node --env-file=.env scripts/seed-notion.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const NOTION = 'https://api.notion.com';
const NOTION_VERSION = '2025-09-03';
const DEMO_DATABASE_URL = 'postgres://slime_reader:slime_reader@localhost:54329/slime';
// Notion allows about 3 requests per second per integration.
const REQUEST_GAP_MS = 400;
const FEEDBACK_COUNT = 40;
const FILMS = ['Castle in the Sky', 'Grave of the Fireflies', 'My Neighbor Totoro', 'Only Yesterday'];
const HOSTS = ['Anna', 'Ben', 'Chen'];
const SENTIMENTS = ['negative', 'negative', 'neutral', 'positive'];
const STATUSES = ['Open', 'Open', 'Triaged', 'Done'];
const AREAS = ['Performance', 'Billing', 'Security', 'UI', 'Export'];
const TITLES = ['Exports time out', 'Invoice PDF is blank', 'SSO login loops', 'Dashboard is slow', 'Love the new charts', 'Search misses results', 'Billing email arrives late', 'Great onboarding'];

// Set once the feedback data source exists: Status is a status property, or a select fallback.
let statusIsSelect = false;
const token = required('NOTION_SEED_TOKEN');
const parentPageId = pageId(required('NOTION_PARENT_PAGE_ID'));
const ENV_FILE = new URL('../.env', import.meta.url);
if (process.env.NOTION_FEEDBACK_ID && !process.argv.includes('--force')) {
  throw new Error('NOTION_FEEDBACK_ID is already set: the demo data exists. Run with --force to create another copy.');
}
const random = seededRandom(42);

const accounts = await accountNames();
const feedbackId = await createDataSource('Customer feedback', feedbackProperties(true)).catch(async (error) => {
  // Older API versions could not create status properties; fall back to a select with the same options.
  if (!String(error.message).includes('status')) throw error;
  console.warn('Status properties could not be created; using a select named Status instead.');
  return createDataSource('Customer feedback', feedbackProperties(false));
});
for (let index = 0; index < FEEDBACK_COUNT; index++) await createPage(feedbackId, feedbackPage(index));
const nightsId = await createDataSource('Movie nights', {
  Film: { title: {} },
  Host: { select: { options: HOSTS.map((name) => ({ name })) } },
  Date: { date: {} },
  Rating: { number: { format: 'number' } },
});
for (let index = 0; index < 15; index++) await createPage(nightsId, nightPage(index));

writeEnvValues({ NOTION_FEEDBACK_ID: feedbackId, NOTION_MOVIE_NIGHTS_ID: nightsId });
console.log(`\nSeeded, and wrote to .env:\nNOTION_FEEDBACK_ID=${feedbackId}\nNOTION_MOVIE_NIGHTS_ID=${nightsId}\nNext: npm run notion:record`);

function writeEnvValues(values) {
  let text = readFileSync(ENV_FILE, 'utf8');
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}=${value}`;
    text = new RegExp(`^${name}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${name}=.*$`, 'm'), line) : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(ENV_FILE, text);
}

// Accepts a bare id, a dashed id, or a whole page URL.
function pageId(value) {
  const hex = value.replace(/-/g, '').match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/i);
  if (!hex) throw new Error(`NOTION_PARENT_PAGE_ID "${value}" has no 32-character page id`);
  return hex[0];
}

function feedbackProperties(useStatus) {
  const statusOptions = { options: STATUSES.filter((name, index, all) => all.indexOf(name) === index).map((name) => ({ name })) };
  return {
    Title: { title: {} },
    Account: { rich_text: {} },
    Sentiment: { select: { options: ['positive', 'neutral', 'negative'].map((name) => ({ name })) } },
    Status: useStatus ? { status: statusOptions } : { select: statusOptions },
    Area: { multi_select: { options: AREAS.map((name) => ({ name })) } },
    Created: { date: {} },
  };
}

function feedbackPage(index) {
  const status = pick(STATUSES);
  return {
    Title: { title: [{ text: { content: pick(TITLES) } }] },
    Account: { rich_text: [{ text: { content: pick(accounts) } }] },
    Sentiment: { select: { name: pick(SENTIMENTS) } },
    Status: statusValue(status),
    Area: { multi_select: [{ name: pick(AREAS) }] },
    Created: { date: { start: daysAgo(index * 2) } },
  };
}

function statusValue(name) {
  return statusIsSelect ? { select: { name } } : { status: { name } };
}

function nightPage(index) {
  return {
    Film: { title: [{ text: { content: FILMS[index % FILMS.length] } }] },
    Host: { select: { name: HOSTS[index % HOSTS.length] } },
    Date: { date: { start: daysAgo(index * 7) } },
    Rating: { number: Math.round((3 + random() * 2) * 2) / 2 },
  };
}

async function createDataSource(title, properties) {
  const database = await notion('POST', '/v1/databases', {
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ text: { content: title } }],
    initial_data_source: { properties },
  });
  const dataSource = database.data_sources?.[0];
  if (!dataSource?.id) throw new Error(`Notion created "${title}" but returned no data source id.`);
  if (title === 'Customer feedback') statusIsSelect = 'select' in properties.Status;
  console.log(`created ${title}: ${dataSource.id}`);
  return dataSource.id;
}

async function createPage(dataSourceId, properties) {
  await notion('POST', '/v1/pages', { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties });
}

async function notion(method, path, body) {
  await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
  const response = await fetch(`${NOTION}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'notion-version': NOTION_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${json.code ?? ''}: ${json.message ?? ''}`);
  return json;
}

async function accountNames() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL || DEMO_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT a.name FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE p.name = 'Enterprise' ORDER BY a.id LIMIT 12");
    return rows.map((row) => row.name);
  } finally {
    await client.end();
  }
}

function pick(list) {
  return list[Math.floor(random() * list.length)];
}

function daysAgo(days) {
  return new Date(Date.UTC(2026, 10, 20) - days * 86_400_000).toISOString().slice(0, 10);
}

// Deterministic, so a reseed gives the same data.
function seededRandom(seed) {
  let state = seed;
  return () => ((state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
}

function required(name) {
  if (!process.env[name]) throw new Error(`Set ${name} in .env (see .env.example).`);
  return process.env[name];
}
