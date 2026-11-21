import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fixtureFetch, fixtureKey, type Fixture } from '../../src/testing/fixture-fetch.js';

let dir = '';
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slime-fixtures-'));
  const fixtures: Record<string, Fixture> = {
    'films.json': { request: { method: 'GET', url: 'https://api.example.com/films?b=2&a=1' }, response: { status: 200, body: [{ id: 1 }] } },
    'query.json': { request: { method: 'POST', url: 'https://api.example.com/query', body: { page_size: 100, filter: { a: 1 } } }, response: { status: 429, headers: { 'retry-after': '1' }, body: {} } },
  };
  for (const [file, fixture] of Object.entries(fixtures)) await writeFile(join(dir, file), JSON.stringify(fixture));
});
after(() => rm(dir, { recursive: true, force: true }));

describe('fixtureFetch', () => {
  test('replays a GET whatever the query order', async () => {
    const response = await fixtureFetch(dir)('https://api.example.com/films?a=1&b=2');
    assert.deepEqual(await response.json(), [{ id: 1 }]);
  });

  test('matches a POST body whatever its key order, with status and headers', async () => {
    const response = await fixtureFetch(dir)('https://api.example.com/query', { method: 'POST', body: JSON.stringify({ filter: { a: 1 }, page_size: 100 }) });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '1');
  });

  test('fails on anything not recorded: another method, path or body', async () => {
    const replay = fixtureFetch(dir);
    await assert.rejects(replay('https://api.example.com/films?a=1&b=2', { method: 'DELETE' }), /No fixture for DELETE/);
    await assert.rejects(replay('https://api.example.com/other'), /No fixture/);
    await assert.rejects(replay('https://api.example.com/query', { method: 'POST', body: '{"page_size":5}' }), /No fixture/);
  });

  test('the key includes the origin', () => {
    assert.notEqual(fixtureKey({ method: 'GET', url: 'https://a.example/x' }), fixtureKey({ method: 'GET', url: 'https://b.example/x' }));
  });
});
