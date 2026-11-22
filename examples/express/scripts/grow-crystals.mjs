// Grows this example's handlers to Crystal without a model, for the Crystal agent
// loop (.github/workflows/crystal-agents.yml) and for trying it locally: the canned
// handlers stand in for the generator, each request runs until it is ready
// (tiers.crystalReadyRuns), and a Crystallizer on the instance writes slime-crystal/.
//   node scripts/grow-crystals.mjs        (needs the demo database: npm run db:up)
import { readFileSync } from 'node:fs';
import { createSlime, memoryStore } from '@slime-cloud/core';
import { cannedGenerator } from '@slime-cloud/core/testing';
import { Crystallizer } from '@slime-cloud/crystal';
import { CRYSTAL_DIR, slimeConfigFromEnv } from '../src/config.mjs';

const CANNED_HANDLERS = JSON.parse(readFileSync(new URL('../test/canned-handlers.json', import.meta.url), 'utf8'));
const COUNTRIES = ['DE', 'US', 'FR', 'GB', 'NL', 'ES', 'IT', 'SE', 'PL', 'CA'];
const DATES = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'];

/** The example's routes, plus one request whose handler has a shape to fold into SQL. */
const REQUESTS = [
  ...DATES.map(() => ({ intent: 'number of accounts on each plan', input: {}, output: [{ plan: 'string', accounts: 'integer' }] })),
  ...DATES.map((_, index) => ({ intent: 'top N accounts by total paid invoice amount in cents, highest first', input: { limit: index + 1 }, output: [{ name: 'string', totalPaidCents: 'integer' }] })),
  ...DATES.map((since) => ({ intent: 'total paid invoice revenue in cents per month since a given date, month formatted YYYY-MM, oldest first', input: { since }, output: [{ month: 'string', revenueCents: 'integer' }] })),
  ...DATES.map((since) => ({ intent: 'accounts with failed invoices since a date, with how many failed invoices each', input: { since }, output: [{ name: 'string', failedInvoices: 'integer' }] })),
  ...COUNTRIES.map((country) => ({ intent: 'plans that have accounts in a given country, each with the list of those account names', input: { country }, output: [{ plan: 'string', accounts: [{ name: 'string' }] }] })),
];

const config = await slimeConfigFromEnv(process.env, { store: memoryStore(), generator: cannedGenerator(CANNED_HANDLERS) });
const slime = await createSlime(config);
try {
  for (const request of REQUESTS) await slime.query(request);
  const reports = await new Crystallizer(slime, { dir: CRYSTAL_DIR }).run();
  for (const { key, intent, outcome, reasons } of reports) {
    console.log(`${outcome}: ${key.slice(0, 12)} ${intent}${reasons.length > 0 ? `\n  ${reasons.join('\n  ')}` : ''}`);
  }
} finally {
  await slime.close();
}
