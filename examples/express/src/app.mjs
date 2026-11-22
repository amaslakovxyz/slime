// The app's endpoints. Each one picks its intent and output and builds the
// input on the server (R11): a client never sends an intent or an identity value.
import express from 'express';
import { SlimeError } from '@slime-cloud/core';

const INTERNAL_ERROR = { code: 'INTERNAL', message: 'Unexpected server error.', retryable: true };

/** Named routes: the intents an app ships with; the client never sends one (R11). */
const ROUTES = [
  {
    path: '/api/plans/accounts',
    intent: 'number of accounts on each plan',
    output: [{ plan: 'string', accounts: 'integer' }],
    input: () => ({}),
  },
  {
    path: '/api/accounts/top',
    intent: 'top N accounts by total paid invoice amount in cents, highest first',
    output: [{ name: 'string', totalPaidCents: 'integer' }],
    input: (query) => ({ limit: integerOrNull(query.limit) }),
  },
  {
    path: '/api/revenue/monthly',
    intent: 'total paid invoice revenue in cents per month since a given date, month formatted YYYY-MM, oldest first',
    output: [{ month: 'string', revenueCents: 'integer' }],
    input: (query) => ({ since: query.since ?? null }),
  },
  {
    path: '/api/accounts/failed-invoices',
    intent: 'accounts with failed invoices since a date, with how many failed invoices each',
    output: [{ name: 'string', failedInvoices: 'integer' }],
    input: (query) => ({ since: query.since ?? null }),
  },
];

/**
 * `exposeDevQuery` adds POST /dev/query, which passes any request to Slime.
 * Only for local development: in production it would let any
 * client generate queries against everything the database user can read (R8, R11).
 */
export function createApp(slime, { exposeDevQuery = false } = {}) {
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_request, response) => response.json(slime.stats()));
  for (const route of ROUTES) {
    app.get(route.path, async (request, response) => {
      response.json(await slime.query({ intent: route.intent, input: route.input(request.query), output: route.output }));
    });
  }
  if (exposeDevQuery) {
    app.post('/dev/query', async (request, response) => response.json(await slime.query(request.body)));
  }

  app.use((error, _request, response, _next) => {
    if (error instanceof SlimeError) return response.status(error.status).json({ error: error.toJSON() });
    // body-parser's own 4xx (malformed JSON, body over the limit): the client must fix it, so not retryable.
    if (error.expose && error.status >= 400 && error.status < 500) {
      return response.status(error.status).json({ error: { code: 'INVALID_REQUEST', message: `The request body is not valid: ${error.message}`, retryable: false } });
    }
    console.error(error);
    return response.status(500).json({ error: INTERNAL_ERROR });
  });
  return app;
}

// "5" from a query string becomes 5; "abc" stays a string, so Slime refuses it (R6).
function integerOrNull(text) {
  if (text === undefined) return null;
  const number = Number(text);
  return Number.isInteger(number) ? number : text;
}
