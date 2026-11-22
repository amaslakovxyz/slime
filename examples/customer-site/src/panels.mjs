// What the customer's coding agent wrote instead of a backend: one Slime request
// spec per dashboard panel. The browser picks a panel and sends input values
// only; intent and output stay here, so a public page can never ask Slime for
// something new (and never spend generation tokens on a whim).
//
// `upstream`: `cloud` is a Slime Cloud endpoint (Postgres only today), `multi` is
// the self-hosted examples/multi-source server (Postgres + Notion + euro rates).
// `crystal`: env names of the Crystal key and its slc_ token; once both are set
// the panel calls the Crystal endpoint instead of POST /v0/query.

export const PANELS = [
  {
    id: 'plan-revenue',
    title: 'Revenue by plan',
    story: 'Finance asks for MRR per plan on the internal dashboard.',
    upstream: 'cloud',
    intent: 'monthly recurring revenue in cents and number of active subscriptions per plan, highest revenue first',
    inputs: {},
    output: [{ plan: 'string', activeSubscriptions: 'integer', mrrCents: 'integer' }],
    crystal: { keyEnv: 'CRYSTAL_PLAN_REVENUE_KEY', tokenEnv: 'CRYSTAL_PLAN_REVENUE_TOKEN' },
  },
  {
    id: 'churn-risk',
    title: 'Churn risk by country',
    story: 'Customer Success wants past-due accounts per country, biggest debt first.',
    upstream: 'cloud',
    intent: 'past-due accounts in a given country with their plan, unpaid invoice total in cents and last activity date, largest unpaid total first',
    // FR first: DE and IT have no past-due accounts in the demo data (an empty answer is still correct).
    inputs: { country: { label: 'Country', options: ['FR', 'ES', 'US', 'NL', 'PL', 'SE', 'DE', 'IT'] } },
    output: [{ name: 'string', plan: 'string', unpaidCents: 'integer', lastActivity: 'date|null' }],
    crystal: { keyEnv: 'CRYSTAL_CHURN_RISK_KEY', tokenEnv: 'CRYSTAL_CHURN_RISK_TOKEN' },
  },
  {
    id: 'customer-360',
    title: 'Customer 360',
    story: 'Account managers want revenue in their currency next to open complaints from Notion.',
    upstream: 'multi',
    // The same text as the multi-source example's canned handler, so its tests cover this panel.
    intent: 'accounts on a given plan with their total paid revenue converted into a given currency and their number of open negative feedback items, most open items first',
    inputs: {
      plan: { label: 'Plan', options: ['Enterprise', 'Growth', 'Starter', 'Free'] },
      currency: { label: 'Currency', options: ['USD', 'GBP', 'CHF', 'JPY'] },
    },
    output: [{ name: 'string', paidRevenue: 'number', openNegative: 'integer' }],
  },
];
