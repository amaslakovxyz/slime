// P6.5 (core/docs/multi-source-implementation.md): the three demo intents against
// seeded Notion, the real films API and a real model, until each is promoted.
// Manual: needs NOTION_TOKEN, NOTION_FEEDBACK_ID, NOTION_MOVIE_NIGHTS_ID and a
// model key in .env, and the demo database.
//
//   node --env-file=.env scripts/live-run.mjs
import { readFileSync } from 'node:fs';
import { createSlime, memoryStore } from '@slime-cloud/core';
import { slimeConfigFromEnv } from '../src/config.mjs';

if (!process.env.GROQ_API_KEY && !process.env.ANTHROPIC_API_KEY) throw new Error('Set GROQ_API_KEY or ANTHROPIC_API_KEY: this run checks a real model.');

const RUNS = 3;
const INTENTS = [
  { intent: 'accounts on a given plan with their total paid revenue in cents and their number of open negative feedback items, most open items first', input: { plan: 'Enterprise' }, output: [{ name: 'string', paidCents: 'integer', openNegative: 'integer' }] },
  { intent: "movie nights with each film's director and running time in minutes, newest first", output: [{ film: 'string', date: 'date|null', director: 'string|null', runningTimeMin: 'integer|null' }] },
  { intent: 'films by a given director with their Rotten Tomatoes score, highest first', input: { director: 'Hayao Miyazaki' }, output: [{ title: 'string', rtScore: 'integer' }] },
];

const events = [];
const config = await slimeConfigFromEnv(process.env, { store: memoryStore(), tiers: { gasToLiquidRuns: RUNS }, limits: { generationBudgetMs: 90_000, reviewTimeoutMs: 120_000 }, onEvent: (event) => events.push(event) });
const slime = await createSlime(config);
try {
  for (const request of INTENTS) {
    let last;
    for (let run = 0; run < RUNS; run++) last = await slime.query(request);
    await slime.flush();
    console.log(`\n=== ${request.intent}`);
    console.log(`steps: ${(last.meta.steps ?? []).map((step) => `${step.source}${step.operation ? ` ${step.operation}` : ''} (${step.rows} rows)`).join(' + ')}`);
    console.log(`first rows: ${JSON.stringify(last.data.slice?.(0, 3) ?? last.data)}`);
    console.log(`tier after ${RUNS} runs: ${slime.handlers().find((handler) => handler.key === last.meta.handlerKey)?.tier}`);
  }
  for (const event of events) if (event.type === 'reviewed') console.log(`review ${event.verdict}: ${event.notes || 'no problems'}`);
  console.log(`\nstats: ${JSON.stringify(slime.stats())}`);
} finally {
  await slime.close();
}
