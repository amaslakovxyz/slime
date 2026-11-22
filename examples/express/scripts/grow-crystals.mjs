// Grows this example's handlers to Crystal without a model, through the app's own
// endpoints, for the Crystal agent loop (.github/workflows/crystal-agents.yml) and for
// trying it locally: the canned handlers stand in for the generator, each request goes
// through POST /query until it is ready (tiers.crystalReadyRuns), then
// POST /crystallize writes slime-crystal/, as it does on a running server.
//   node scripts/grow-crystals.mjs        (needs the demo database: npm run db:up)
import { readFileSync } from 'node:fs';
import { createSlime, memoryStore } from '@slime-cloud/core';
import { cannedGenerator } from '@slime-cloud/core/testing';
import { Crystallizer } from '@slime-cloud/crystal';
import { createApp } from '../src/app.mjs';
import { CRYSTAL_DIR, slimeConfigFromEnv } from '../src/config.mjs';

const CANNED_HANDLERS = JSON.parse(readFileSync(new URL('../test/canned-handlers.json', import.meta.url), 'utf8'));
const COUNTRIES = ['DE', 'US', 'FR', 'GB', 'NL', 'ES', 'IT', 'SE', 'PL', 'CA'];
const DATES = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'];

/** The requests the canned handlers answer; the last one's handler has a shape to fold into SQL. */
const REQUESTS = [
  ...DATES.map(() => ({ intent: 'number of accounts on each plan', input: {}, output: [{ plan: 'string', accounts: 'integer' }] })),
  ...DATES.map((_, index) => ({ intent: 'top N accounts by total paid invoice amount in cents, highest first', input: { limit: index + 1 }, output: [{ name: 'string', totalPaidCents: 'integer' }] })),
  ...DATES.map((since) => ({ intent: 'total paid invoice revenue in cents per month since a given date, month formatted YYYY-MM, oldest first', input: { since }, output: [{ month: 'string', revenueCents: 'integer' }] })),
  ...DATES.map((since) => ({ intent: 'accounts with failed invoices since a date, with how many failed invoices each', input: { since }, output: [{ name: 'string', failedInvoices: 'integer' }] })),
  ...COUNTRIES.map((country) => ({ intent: 'plans that have accounts in a given country, each with the list of those account names', input: { country }, output: [{ plan: 'string', accounts: [{ name: 'string' }] }] })),
];

const config = await slimeConfigFromEnv(process.env, { store: memoryStore(), generator: cannedGenerator(CANNED_HANDLERS) });
const slime = await createSlime(config);
const server = createApp(slime, new Crystallizer(slime, { dir: CRYSTAL_DIR })).listen(0, '127.0.0.1');
try {
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const request of REQUESTS) await post(`${base}/query`, request);
  const { reports } = await post(`${base}/crystallize`, {});
  for (const { key, intent, outcome, reasons } of reports) {
    console.log(`${outcome}: ${key.slice(0, 12)} ${intent}${reasons.length > 0 ? `\n  ${reasons.join('\n  ')}` : ''}`);
  }
} finally {
  server.close();
  await slime.close();
}

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(`${url}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}
