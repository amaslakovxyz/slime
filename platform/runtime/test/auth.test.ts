// Who may call what: the endpoint key opens everything, a Crystal token only its own route.
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isAuthorized, parseCrystalTokens } from '../src/auth.js';

const tokens = { k1: 'slc_one', k2: 'slc_two' };

describe('isAuthorized', () => {
  test('the endpoint key opens every route', () => {
    for (const path of ['/v0/query', '/v0/e/k1', '/v0/lifecycle', '/healthz']) assert.equal(isAuthorized('POST', path, 'slm_key', 'slm_key', tokens), true);
  });

  test("a Crystal token opens only its own Crystal's route", () => {
    assert.equal(isAuthorized('POST', '/v0/e/k1', 'slc_one', 'slm_key', tokens), true);
    assert.equal(isAuthorized('POST', '/v0/e/k2', 'slc_one', 'slm_key', tokens), false);
    assert.equal(isAuthorized('POST', '/v0/query', 'slc_one', 'slm_key', tokens), false);
    assert.equal(isAuthorized('GET', '/v0/lifecycle', 'slc_one', 'slm_key', tokens), false);
    assert.equal(isAuthorized('GET', '/v0/e/k1', 'slc_one', 'slm_key', tokens), false);
    assert.equal(isAuthorized('POST', '/v0/e/k1/x', 'slc_one', 'slm_key', tokens), false);
  });

  test('no key, a wrong key, or a Crystal without a token is refused', () => {
    assert.equal(isAuthorized('POST', '/v0/e/k1', undefined, 'slm_key', tokens), false);
    assert.equal(isAuthorized('POST', '/v0/e/k1', 'nope', 'slm_key', tokens), false);
    assert.equal(isAuthorized('POST', '/v0/e/k3', 'slc_one', 'slm_key', tokens), false);
    assert.equal(isAuthorized('POST', '/v0/query', 'slm_key', undefined, tokens), false);
  });
});

describe('parseCrystalTokens', () => {
  test('keeps string tokens and ignores anything malformed', () => {
    assert.deepEqual(parseCrystalTokens('{"a":"slc_x","b":7,"c":""}'), { a: 'slc_x' });
    assert.deepEqual(parseCrystalTokens('not json'), {});
    assert.deepEqual(parseCrystalTokens('["slc_x"]'), {});
    assert.deepEqual(parseCrystalTokens(undefined), {});
  });
});
