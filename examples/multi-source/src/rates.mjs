// Euro exchange rates (Frankfurter, ECB reference rates) as a Slime API source:
// the customer demo converts invoice totals, kept in EUR cents, into another
// currency. Public and keyless; one row per currency.
import { defineApiSource } from '@slime-cloud/core';

const BASE_URL = 'https://api.frankfurter.dev';

/** `fetchImpl` lets tests replay recorded responses instead of calling the API. */
export function euroRates({ fetchImpl } = {}) {
  return defineApiSource({
    name: 'frankfurter',
    service: 'Frankfurter euro exchange rates (public, read-only)',
    baseUrl: BASE_URL,
    ...(fetchImpl ? { fetchImpl } : {}),
    operations: {
      'rates.latest': {
        description: 'Latest ECB reference rates: how many units of a currency one euro buys',
        params: { currency: { type: 'string', comment: 'ISO 4217 code, for example USD; null returns every currency' } },
        columns: { currency: 'string', perEur: 'number', date: 'date' },
        primaryKey: ['currency'],
        async run({ currency }, { http }) {
          const { date, rates } = await http.getJson('/v1/latest', { base: 'EUR', symbols: currency });
          return Object.entries(rates).map(([code, perEur]) => ({ currency: code, perEur, date }));
        },
      },
    },
    check: async ({ http }) => {
      await http.getJson('/v1/latest', { base: 'EUR', symbols: 'USD' });
    },
  });
}
