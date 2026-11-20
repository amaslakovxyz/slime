// Illustrative prices for the usage estimate; there is no payment integration.
export const PRICE_PER_1K_REQUESTS_USD = 0.5;
export const PRICE_PER_GENERATION_USD = 0.02;

export function estimateBill({ requests, generations }: { requests: number; generations: number }): number {
  const usd = (requests / 1000) * PRICE_PER_1K_REQUESTS_USD + generations * PRICE_PER_GENERATION_USD;
  return Math.round(usd * 100) / 100;
}
