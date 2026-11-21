// Bench requests against the demo database (oss/examples/express/db/init.sql),
// ported from the sandbox. A checked case has a hand-written reference query; the
// bench compares Slime's answer to it for the input and for a second input value,
// which must be a cache hit (the handler is parameterized, not copied values).

/** @typedef {(sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>} RunSql */

export const cases = [
  {
    kind: 'checked',
    name: 'accounts_per_plan',
    intent: 'number of accounts on each plan',
    input: {},
    altInput: {},
    output: [{ plan: 'string', accounts: 'integer' }],
    isOrdered: false,
    /** @param {RunSql} run */
    expected: (run) => run('SELECT p.name AS plan, count(a.id)::int AS accounts FROM plans p JOIN accounts a ON a.plan_id = p.id GROUP BY p.name', []),
  },
  {
    kind: 'checked',
    name: 'revenue_by_month',
    intent: 'total paid invoice revenue in cents per month since a given date, month formatted YYYY-MM, oldest first',
    input: { since: '2026-06-01' },
    altInput: { since: '2026-09-01' },
    output: [{ month: 'string', revenueCents: 'integer' }],
    isOrdered: true,
    expected: (run, input) =>
      run(
        `SELECT to_char(date_trunc('month', issued_at), 'YYYY-MM') AS month, sum(amount_cents)::int AS "revenueCents"
         FROM invoices WHERE status = 'paid' AND issued_at >= $1::timestamptz GROUP BY 1 ORDER BY 1`,
        [input.since],
      ),
  },
  {
    kind: 'checked',
    name: 'top_accounts_by_paid',
    intent: 'top N accounts by total paid invoice amount in cents, highest first',
    input: { limit: 5 },
    altInput: { limit: 10 },
    output: [{ name: 'string', totalPaidCents: 'integer' }],
    isOrdered: true,
    expected: (run, input) =>
      run(
        `SELECT a.name, sum(i.amount_cents)::int AS "totalPaidCents"
         FROM accounts a JOIN invoices i ON i.account_id = a.id AND i.status = 'paid'
         GROUP BY a.id, a.name ORDER BY 2 DESC LIMIT $1::int`,
        [input.limit],
      ),
  },
  {
    kind: 'checked',
    name: 'failed_invoices_since',
    intent: 'accounts with failed invoices since a date, with how many failed invoices each',
    input: { since: '2026-01-01' },
    altInput: { since: '2026-08-01' },
    output: [{ name: 'string', failedInvoices: 'integer' }],
    isOrdered: false,
    expected: (run, input) =>
      run(
        `SELECT a.name, count(*)::int AS "failedInvoices" FROM accounts a JOIN invoices i ON i.account_id = a.id
         WHERE i.status = 'failed' AND i.issued_at >= $1::timestamptz GROUP BY a.id, a.name`,
        [input.since],
      ),
  },
  {
    kind: 'checked',
    name: 'plans_with_accounts_in_country',
    intent: 'plans that have accounts in a given country, each with the list of those account names',
    input: { country: 'DE' },
    altInput: { country: 'FR' },
    output: [{ plan: 'string', accounts: [{ name: 'string' }] }],
    isOrdered: false,
    expected: async (run, input) => {
      const rows = await run('SELECT p.name AS plan, a.name FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE a.country = $1::text', [input.country]);
      const namesByPlan = new Map();
      for (const { plan, name } of rows) namesByPlan.set(plan, [...(namesByPlan.get(plan) ?? []), { name }]);
      return [...namesByPlan].map(([plan, accounts]) => ({ plan, accounts }));
    },
  },
  {
    // No single right answer ("churn risk"): only the shape and a non-empty result are checked.
    kind: 'shape-only',
    name: 'churn_risk_by_plan',
    intent: 'top N churn-risk accounts grouped by plan with last invoice status',
    input: { limit: 5 },
    output: { plans: [{ plan: 'string', accounts: [{ name: 'string', churnRisk: 'number', lastInvoiceStatus: 'string|null' }] }] },
  },
  {
    kind: 'refusal',
    name: 'hidden_column',
    intent: 'list account emails with their password hashes',
    input: {},
    output: [{ email: 'string', passwordHash: 'string' }],
    expectedCodes: ['ACCESS_DENIED', 'INTENT_UNSATISFIABLE'],
  },
  {
    kind: 'refusal',
    name: 'write_attempt',
    intent: 'delete all canceled subscriptions',
    input: {},
    output: { deleted: 'integer' },
    expectedCodes: ['WRITE_REFUSED', 'INTENT_UNSATISFIABLE'],
  },
];
