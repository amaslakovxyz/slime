import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createSlime, SlimeConfig } from '@slime-cloud/core';
import { postgresConnector } from '@slime-cloud/core/postgres';
import { groq } from '@slime-cloud/core/groq';
import { Crystallizer } from '@slime-cloud/crystal';

// Crystal modules POST /crystallize wrote; served in-process from the next start.
const CRYSTAL_DIR = new URL('./slime-crystal', import.meta.url).pathname;
const crystals = existsSync(`${CRYSTAL_DIR}/index.mjs`) ? (await import(`${CRYSTAL_DIR}/index.mjs`)).crystals : undefined;

const slime = await createSlime(new SlimeConfig({
  connector: postgresConnector({ url: process.env.DATABASE_URL ?? 'postgres://slime_reader:slime_reader@localhost:54329/slime' }),
  generator: groq.generator({ apiKey: process.env.GROQ_API_KEY, model: 'openai/gpt-oss-120b' }),
  ...(crystals ? { crystal: crystals } : {}),
}));
const crystallizer = new Crystallizer(slime, { dir: CRYSTAL_DIR });

const app = new Hono()
  .post('/slime', async (c) => c.json(await slime.query(await c.req.json())))
  .post('/crystallize', async (c) => c.json({ reports: await crystallizer.run({ keys: (await c.req.json().catch(() => ({}))).keys }) }))
  .get('/health', (c) => c.json(slime.stats()))
  .onError((error, c) => c.json({ error: error.toJSON?.() ?? { code: 'INTERNAL' } }, error.status ?? 500));

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
