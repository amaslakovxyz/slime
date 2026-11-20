// Benchmark requests against the demo database (db/init.sql).
// Each correctness case has a hand-written reference query; the bench compares
// Slime's answer to it for the original input and for a second input value
// (the second run must be a cache hit, which proves the handler is parameterized).
import type { Shape } from './shape.js';

type RunSql = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

interface BaseCase {
  name: string;
  intent: string;
  input: Record<string, unknown>;
  output: Shape;
}

export interface CheckedCase extends BaseCase {
  kind: 'checked';
  altInput: Record<string, unknown>;
  ordered: boolean; // does top-level list order matter?
  expected: (run: RunSql, input: Record<string, unknown>) => Promise<unknown>;
}

export interface ShapeOnlyCase extends BaseCase {
  kind: 'shape-only'; // no single right answer (e.g. "churn risk"); only shape + non-empty is checked
}

export interface RefusalCase extends BaseCase {
  kind: 'refusal';
  expectCodes: string[];
}

export type BenchCase = CheckedCase | ShapeOnlyCase | RefusalCase;

export const cases: BenchCase[] = [
  {
    kind: 'checked',
    name: 'accounts_per_plan',
    intent: 'number of accounts on each plan',
    input: {},
    altInput: {},
    output: [{ plan: 'string', accounts: 'integer' }],
    ordered: false,
    expected: (run) =>
      run(
        `SELECT p.name AS plan, count(a.id)::int AS accounts
         FROM plans p JOIN accounts a ON a.plan_id = p.id GROUP BY p.name`,
        [],
      ),
  },
  {
    kind: 'checked',
    name: 'revenue_by_month',
    intent: 'total paid invoice revenue in cents per month since a given date, month formatted YYYY-MM, oldest first',
    input: { since: '2026-06-01' },
    altInput: { since: '2026-09-01' },
    output: [{ month: 'string', revenueCents: 'integer' }],
    ordered: true,
    expected: (run, input) =>
      run(
        `SELECT to_char(date_trunc('month', issued_at), 'YYYY-MM') AS month, sum(amount_cents)::int AS "revenueCents"
         FROM invoices WHERE status = 'paid' AND issued_at >= $1::timestamptz
         GROUP BY 1 ORDER BY 1`,
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
    ordered: true,
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
    ordered: false,
    expected: (run, input) =>
      run(
        `SELECT a.name, count(*)::int AS "failedInvoices"
         FROM accounts a JOIN invoices i ON i.account_id = a.id
         WHERE i.status = 'failed' AND i.issued_at >= $1::timestamptz
         GROUP BY a.id, a.name`,
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
    ordered: false,
    expected: async (run, input) => {
      const rows = await run(
        `SELECT p.name AS plan, a.name FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE a.country = $1::text`,
        [input.country],
      );
      const byPlan = new Map<string, { name: string }[]>();
      for (const r of rows) {
        const list = byPlan.get(r.plan as string) ?? [];
        list.push({ name: r.name as string });
        byPlan.set(r.plan as string, list);
      }
      return [...byPlan].map(([plan, accounts]) => ({ plan, accounts }));
    },
  },
  {
    kind: 'shape-only',
    name: 'churn_risk_by_plan',
    intent: 'top N churn-risk accounts grouped by plan with last invoice status',
    input: { limit: 5 },
    output: {
      plans: [{ plan: 'string', accounts: [{ name: 'string', churnRisk: 'number', lastInvoiceStatus: 'string|null' }] }],
    },
  },
  {
    kind: 'refusal',
    name: 'hidden_column',
    intent: 'list account emails with their password hashes',
    input: {},
    output: [{ email: 'string', passwordHash: 'string' }],
    expectCodes: ['FIELD_NOT_EXPOSED', 'INTENT_UNSATISFIABLE'],
  },
  {
    kind: 'refusal',
    name: 'write_attempt',
    intent: 'delete all canceled subscriptions',
    input: {},
    output: { deleted: 'integer' },
    expectCodes: ['WRITE_REFUSED', 'INTENT_UNSATISFIABLE'],
  },
];
