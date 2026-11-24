// The feed keeps each request's trace, refused requests too, and never an input value (request trace design T4–T6).
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SlimeError, type QueryMeta, type Slime } from '@slime-cloud/core';
import { createApp } from '../src/app.js';
import { RecentRequests } from '../src/events.js';

const connector = { safetyCheck: async () => ({ ok: true }) } as never;
const BODY = { intent: 'accounts in a country', input: { country: 'DE-SECRET', limit: 5 }, output: [{ name: 'string' }] };
const TRACE = [{ layer: 'key', status: 'pass' }, { layer: 'route', status: 'pass', note: 'cache miss → generate' }];

function slimeAnswering(meta: Partial<QueryMeta>): Slime {
  return { query: async () => ({ data: [], meta: { handlerKey: 'k1', tier: 'gas', cache: 'miss', timingsMs: { total: 5, run: 1, shape: 0 }, sql: 'SELECT 1', assumptions: ['a'], trace: TRACE, ...meta } }) } as unknown as Slime;
}
function slimeRefusing(error: unknown): Slime {
  return { query: async () => { throw error; } } as unknown as Slime;
}
const post = (body: string, headers: Record<string, string> = {}) => ({ method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

describe('feed: answered requests', () => {
  test('a generation keeps intent, input names, the trace behind edge, and the code', async () => {
    const events = new RecentRequests();
    const app = createApp({ slime: slimeAnswering({}), connector, events });
    const body = JSON.stringify(BODY);
    await app.request('/v0/query', post(body, { 'content-length': String(body.length) }));
    const [e] = events.list().events;
    assert.equal(e!.status, 200);
    assert.equal(e!.intent, BODY.intent);
    assert.deepEqual(e!.inputs, ['country', 'limit']);
    assert.deepEqual(e!.trace!.map((s) => s.layer), ['edge', 'key', 'route']);
    assert.equal(e!.trace![0]!.note, `API key · body ${body.length} B`);
    assert.deepEqual(e!.generated, { sql: 'SELECT 1', assumptions: ['a'] });
    assert.equal(e!.stopAt, undefined);
    assert.ok(!JSON.stringify(e).includes('DE-SECRET'));
  });

  test('a hit stores no code', async () => {
    const events = new RecentRequests();
    await createApp({ slime: slimeAnswering({ cache: 'hit' }), connector, events }).request('/v0/query', post(JSON.stringify(BODY)));
    assert.equal(events.list().events[0]!.generated, undefined);
  });

  test('the intent is cut at 200 characters', async () => {
    const events = new RecentRequests();
    await createApp({ slime: slimeAnswering({}), connector, events }).request('/v0/query', post(JSON.stringify({ ...BODY, intent: 'x'.repeat(500) })));
    assert.equal(events.list().events[0]!.intent!.length, 200);
  });
});

describe('feed: refused requests', () => {
  test('a refusal from the engine keeps its code, stop layer, key and trace', async () => {
    const error = new SlimeError('WRITE_REFUSED', 'reads as a write', { details: { enforcedBy: 'lint' } });
    error.trace = [{ layer: 'key', status: 'pass' }, { layer: 'lint', status: 'stop', note: 'WRITE_REFUSED: reads as a write', attempt: 1 }];
    error.handlerKey = 'k9';
    const events = new RecentRequests();
    const res = await createApp({ slime: slimeRefusing(error), connector, events }).request('/v0/query', post(JSON.stringify(BODY)));
    assert.equal(res.status, 403);
    const [e] = events.list().events;
    assert.equal(e!.status, 403);
    assert.equal(e!.code, 'WRITE_REFUSED');
    assert.equal(e!.stopAt, 'lint');
    assert.equal(e!.handlerKey, 'k9');
    assert.equal(e!.tier, undefined);
    assert.deepEqual(e!.trace!.map((s) => `${s.layer}:${s.status}`), ['edge:pass', 'key:pass', 'lint:stop']);
    assert.deepEqual(await res.json(), { error: error.toJSON() }, 'the response body is unchanged');
  });

  test('invalid JSON stops at key', async () => {
    const events = new RecentRequests();
    await createApp({ slime: slimeAnswering({}), connector, events }).request('/v0/query', post('{nope'));
    const [e] = events.list().events;
    assert.equal(e!.code, 'INVALID_REQUEST');
    assert.equal(e!.stopAt, 'key');
  });

  test('a body over 16 KB stops at edge', async () => {
    const events = new RecentRequests();
    const big = JSON.stringify({ ...BODY, intent: 'x'.repeat(17 * 1024) });
    const res = await createApp({ slime: slimeAnswering({}), connector, events }).request('/v0/query', post(big, { 'content-length': String(big.length) }));
    assert.equal(res.status, 413);
    const [e] = events.list().events;
    assert.equal(e!.stopAt, 'edge');
    assert.equal(e!.status, 413);
  });

  test('an unexpected error is recorded as INTERNAL', async () => {
    const events = new RecentRequests();
    const res = await createApp({ slime: slimeRefusing(new TypeError('boom')), connector, events }).request('/v0/query', post(JSON.stringify(BODY)));
    assert.equal(res.status, 500);
    assert.equal(events.list().events[0]!.code, 'INTERNAL');
  });
});
