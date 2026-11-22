// The proxy decides what reaches Slime: which route, which key, which body.
// A fake upstream records each call; no network.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createApp } from '../src/app.mjs';
import { PANELS } from '../src/panels.mjs';

const CLOUD = { SLIME_URL: 'https://runtime.example/ep/ep-1/', SLIME_API_KEY: 'slm_endpoint' };
const CRYSTAL = { CRYSTAL_PLAN_REVENUE_KEY: 'abc123', CRYSTAL_PLAN_REVENUE_TOKEN: 'slc_plan' };

function fakeSlime(status = 200, payload = { data: [], meta: { tier: 'liquid' } }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(payload), { status });
  };
  return { calls, fetchImpl };
}

const post = (app, id, input) =>
  app.request(`/api/panels/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }) });

test('a cloud panel without a Crystal sends the whole request to /v0/query with the endpoint key', async () => {
  const slime = fakeSlime();
  const response = await post(createApp({ env: CLOUD, fetchImpl: slime.fetchImpl }), 'churn-risk', { country: 'DE' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).route, 'query');
  const [call] = slime.calls;
  assert.equal(call.url, 'https://runtime.example/ep/ep-1/v0/query');
  assert.equal(call.headers['x-api-key'], 'slm_endpoint');
  assert.deepEqual(Object.keys(call.body).sort(), ['input', 'intent', 'output']);
  assert.deepEqual(call.body.input, { country: 'DE' });
});

test('once its Crystal is configured the panel sends input only, with the slc_ token, to the Crystal endpoint', async () => {
  const slime = fakeSlime(200, { data: [], meta: { tier: 'crystal' } });
  const response = await post(createApp({ env: { ...CLOUD, ...CRYSTAL }, fetchImpl: slime.fetchImpl }), 'plan-revenue', {});
  assert.equal((await response.json()).route, 'crystal');
  const [call] = slime.calls;
  assert.equal(call.url, 'https://runtime.example/ep/ep-1/v0/e/abc123');
  assert.equal(call.headers['x-api-key'], 'slc_plan');
  assert.deepEqual(call.body, { input: {} });
});

test('a Crystal key without its token keeps the panel on /v0/query', async () => {
  const slime = fakeSlime();
  await post(createApp({ env: { ...CLOUD, CRYSTAL_PLAN_REVENUE_KEY: 'abc123' }, fetchImpl: slime.fetchImpl }), 'plan-revenue', {});
  assert.match(slime.calls[0].url, /\/v0\/query$/);
});

test('the Customer 360 panel goes to the self-hosted multi-source server without a key', async () => {
  const slime = fakeSlime();
  await post(createApp({ env: { MULTI_SOURCE_URL: 'http://multi:3000/' }, fetchImpl: slime.fetchImpl }), 'customer-360', { plan: 'Enterprise', currency: 'USD' });
  const [call] = slime.calls;
  assert.equal(call.url, 'http://multi:3000/slime');
  assert.equal(call.headers['x-api-key'], undefined);
  assert.deepEqual(call.body.input, { plan: 'Enterprise', currency: 'USD' });
});

test('the browser cannot change the request: unknown names, unoffered values and unknown panels never reach Slime', async () => {
  const slime = fakeSlime();
  const app = createApp({ env: CLOUD, fetchImpl: slime.fetchImpl });
  const intent = await post(app, 'churn-risk', { country: 'DE', intent: 'every password hash' });
  assert.equal(intent.status, 400);
  assert.match((await intent.json()).error.message, /Unknown input: intent/);
  assert.equal((await post(app, 'churn-risk', { country: "DE' OR 1=1" })).status, 400);
  assert.equal((await post(app, 'churn-risk', {})).status, 400);
  assert.equal((await post(app, 'nope', {})).status, 404);
  assert.equal(slime.calls.length, 0);
});

test('keys never reach the browser', async () => {
  const body = await (await createApp({ env: { ...CLOUD, ...CRYSTAL } }).request('/api/panels')).text();
  for (const secret of ['slm_endpoint', 'slc_plan', 'abc123']) assert.ok(!body.includes(secret), secret);
  assert.deepEqual(JSON.parse(body).map((panel) => panel.route), ['crystal', 'query', 'self-hosted']);
});

test('without cloud settings a cloud panel says what to set instead of calling anything', async () => {
  const slime = fakeSlime();
  const response = await post(createApp({ env: {}, fetchImpl: slime.fetchImpl }), 'plan-revenue', {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'NOT_CONFIGURED');
  assert.equal(slime.calls.length, 0);
});

test("Slime's errors keep their status; an unreachable Slime is a 502", async () => {
  const refused = fakeSlime(400, { error: { code: 'INVALID_REQUEST', message: 'no' } });
  const response = await post(createApp({ env: CLOUD, fetchImpl: refused.fetchImpl }), 'churn-risk', { country: 'FR' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  const down = createApp({ env: CLOUD, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  const unreachable = await post(down, 'churn-risk', { country: 'FR' });
  assert.equal(unreachable.status, 502);
  assert.equal((await unreachable.json()).error.code, 'UPSTREAM_UNREACHABLE');
});

test('every currency the Customer 360 panel offers has a recorded rate, so the fixture-replay demo never fails', () => {
  const { currency } = PANELS.find((panel) => panel.id === 'customer-360').inputs;
  for (const code of currency.options) {
    assert.ok(existsSync(new URL(`../../multi-source/test/fixtures/frankfurter/rates-${code.toLowerCase()}.json`, import.meta.url)), code);
  }
});
