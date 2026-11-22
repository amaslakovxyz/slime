// Builds the SlimeConfig from this app's environment. Core never reads env; the app does.
import { SlimeConfig } from '@slime-cloud/core';
import { notionSource } from '@slime-cloud/core/notion';
import { postgresConnector } from '@slime-cloud/core/postgres';
import { fixtureFetch } from '@slime-cloud/core/testing';
import { ghibliFilms } from './films.mjs';

const APP_DIR = new URL('..', import.meta.url);
const DEMO_DATABASE_URL = 'postgres://slime_reader:slime_reader@localhost:54329/slime';
// The ids in test/fixtures/notion, used when FETCH_FIXTURES=1.
const FIXTURE_FEEDBACK_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const FIXTURE_MOVIE_NIGHTS_ID = '1a1b1c1d-1e1f-4a2b-8c3d-4e5f60718293';
const FIXTURE_TOKEN = 'fixture-token';
const NOTION_HOST = 'api.notion.com';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const CLAUDE_GENERATOR_MODEL = 'claude-haiku-5-5';
const CLAUDE_REVIEW_MODEL = 'claude-opus-5-5';

/** Join hints across sources are column comments (MS13). */
const NOTION_COMMENTS = {
  feedback: { account: 'matches db.accounts.name' },
  movieNights: { film: 'matches title in films operation films.list' },
};

export async function slimeConfigFromEnv(env = process.env, overrides = {}) {
  const useFixtures = env.FETCH_FIXTURES === '1';
  const fetchImpl = useFixtures ? recordedFetch() : undefined;
  const notion = notionSource({
    token: useFixtures ? FIXTURE_TOKEN : required(env, 'NOTION_TOKEN'),
    dataSources: {
      feedback: useFixtures ? FIXTURE_FEEDBACK_ID : required(env, 'NOTION_FEEDBACK_ID'),
      movieNights: useFixtures ? FIXTURE_MOVIE_NIGHTS_ID : required(env, 'NOTION_MOVIE_NIGHTS_ID'),
    },
    comments: NOTION_COMMENTS,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return new SlimeConfig({
    sources: { db: postgresConnector({ url: env.DATABASE_URL || DEMO_DATABASE_URL }), notion, films: ghibliFilms(fetchImpl ? { fetchImpl } : {}) },
    glossary: { revenue: 'sum of paid invoices, in cents' },
    rules: ['Revenue counts only invoices with status paid.'],
    ...(overrides.generator ? {} : await chooseModels(env)),
    ...overrides,
  });
}

/** A model key picks the provider; tests pass their own `generator`. */
async function chooseModels(env) {
  if (env.GROQ_API_KEY) {
    const { groq } = await import('@slime-cloud/core/groq');
    const options = { apiKey: env.GROQ_API_KEY, model: GROQ_MODEL };
    return { generator: groq.generator({ ...options, reasoningEffort: 'medium' }), reviewer: groq.reviewer({ ...options, reasoningEffort: 'high' }) };
  }
  if (env.ANTHROPIC_API_KEY) {
    const { claude } = await import('@slime-cloud/core/claude');
    const apiKey = env.ANTHROPIC_API_KEY;
    return { generator: claude.generator({ apiKey, model: CLAUDE_GENERATOR_MODEL }), reviewer: claude.reviewer({ apiKey, model: CLAUDE_REVIEW_MODEL }) };
  }
  throw new Error('Set GROQ_API_KEY or ANTHROPIC_API_KEY: Slime generates a handler for each new request with that model.');
}

// Replays test/fixtures: Notion's from one folder, the films API's from another.
function recordedFetch() {
  const notionFetch = fixtureFetch(new URL('test/fixtures/notion/', APP_DIR));
  const filmsFetch = fixtureFetch(new URL('test/fixtures/ghibli/', APP_DIR));
  return (input, init) => (new URL(String(input)).host === NOTION_HOST ? notionFetch : filmsFetch)(input, init);
}

function required(env, name) {
  if (!env[name]) throw new Error(`Set ${name} (see .env.example), or FETCH_FIXTURES=1 to replay the recorded APIs.`);
  return env[name];
}
