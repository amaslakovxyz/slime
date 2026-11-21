import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createSlime, SlimeConfig } from '@slime-cloud/core';
import { postgresConnector } from '@slime-cloud/core/postgres';
import { groq } from '@slime-cloud/core/groq';

const slime = await createSlime(new SlimeConfig({
  connector: postgresConnector({ url: process.env.DATABASE_URL ?? 'postgres://slime_reader:slime_reader@localhost:54329/slime' }),
  generator: groq.generator({ apiKey: process.env.GROQ_API_KEY, model: 'openai/gpt-oss-120b' }),
}));

const app = new Hono()
  .get('/health', (c) => c.json(slime.stats()))
  .get('/plans', async (c) => c.json(await slime.query({ intent: 'number of accounts on each plan', input: {}, output: [{ plan: 'string', accounts: 'integer' }] })))
  .onError((error, c) => c.json({ error: error.toJSON?.() ?? { code: 'INTERNAL' } }, error.status ?? 500));

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
