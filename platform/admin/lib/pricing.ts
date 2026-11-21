// Illustrative prices for the usage estimate; there is no payment integration.
// Each request is priced by the tier that served it, so crystallized handlers
// get cheaper as well as faster.
export const TIERS = ['gas', 'liquid', 'crystal'] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_PRICE_PER_1K_USD: Record<Tier, number> = { gas: 2.0, liquid: 0.5, crystal: 0.1 };
export const PRICE_PER_GENERATION_USD = 0.02;

export interface Billable {
  gasRequests: number;
  liquidRequests: number;
  crystalRequests: number;
  generations: number;
}

const cents = (usd: number) => Math.round(usd * 100) / 100;
const requestsOf = (b: Billable, tier: Tier) => b[`${tier}Requests`];
const rawBill = (b: Billable) =>
  TIERS.reduce((sum, tier) => sum + (requestsOf(b, tier) / 1000) * TIER_PRICE_PER_1K_USD[tier], 0) +
  b.generations * PRICE_PER_GENERATION_USD;
// What the same traffic would cost if nothing had left the Gas tier.
const rawAllGas = (b: Billable) =>
  (TIERS.reduce((sum, tier) => sum + requestsOf(b, tier), 0) / 1000) * TIER_PRICE_PER_1K_USD.gas +
  b.generations * PRICE_PER_GENERATION_USD;

export const tierCost = (tier: Tier, requests: number) => cents((requests / 1000) * TIER_PRICE_PER_1K_USD[tier]);
export const generationCost = (generations: number) => cents(generations * PRICE_PER_GENERATION_USD);
export const estimateBill = (b: Billable) => cents(rawBill(b));
export const allGasBill = (b: Billable) => cents(rawAllGas(b));
export const crystallizationSavings = (b: Billable) => cents(rawAllGas(b) - rawBill(b));
