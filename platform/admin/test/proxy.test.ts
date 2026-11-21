// The CloudFront origin check: with SLIME_ORIGIN_SECRET set, only requests that
// carry it in x-slime-origin reach the admin.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';

process.env.SESSION_SECRET ??= 'test-secret-that-is-at-least-32-characters';

const request = (headers: Record<string, string> = {}, path = '/login') =>
  new NextRequest(`https://admin.example.com${path}`, { method: 'POST', headers });
/** NextResponse.next() marks a response that lets the request through. */
const passes = (res: Response) => res.headers.get('x-middleware-next') === '1';

describe('origin check (proxy.ts)', () => {
  afterEach(() => {
    delete process.env.SLIME_ORIGIN_SECRET;
  });

  test('without a configured secret (local) every request passes', () => {
    assert.ok(passes(proxy(request())));
  });

  test('a missing, wrong or prefix-only header is refused with 403 on every path', () => {
    process.env.SLIME_ORIGIN_SECRET = 's3cret-from-terraform';
    const cases: Record<string, string>[] = [{}, { 'x-slime-origin': 'wrong' }, { 'x-slime-origin': 's3cret' }, { 'x-slime-origin': '' }];
    for (const headers of cases) {
      const res = proxy(request(headers));
      assert.equal(res.status, 403);
      assert.equal(passes(res), false);
    }
    assert.equal(proxy(request({}, '/_next/static/chunk.js')).status, 403);
  });

  test('the right header passes', () => {
    process.env.SLIME_ORIGIN_SECRET = 's3cret-from-terraform';
    assert.ok(passes(proxy(request({ 'x-slime-origin': 's3cret-from-terraform' }))));
  });
});
