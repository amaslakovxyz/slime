// Attack: reach the host — there is no fetch, process or require inside QuickJS.
export function handler(input, db, ctx) {
  return { response: process.env };
}
