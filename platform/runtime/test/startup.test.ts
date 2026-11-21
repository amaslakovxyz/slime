// What the local entry reports when it cannot start or cannot generate, so the
// admin shows a reason instead of a stack trace's last lines or a READY endpoint
// that answers every new request with 502.
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { missingProviderKey } from '../src/config.js';
import { startupErrorMessage } from '../src/local.js';

describe('missingProviderKey', () => {
  test('names the variable a model provider needs when it is unset or blank', () => {
    assert.match(missingProviderKey({ SLIME_PROVIDER: 'groq' }) ?? '', /GROQ_API_KEY/);
    assert.match(missingProviderKey({ SLIME_PROVIDER: 'groq', GROQ_API_KEY: '  ' }) ?? '', /GROQ_API_KEY/);
    assert.match(missingProviderKey({}) ?? '', /ANTHROPIC_API_KEY/, 'claude is the default provider');
  });

  test('is silent when the key is set, offline, or locked (no generation)', () => {
    assert.equal(missingProviderKey({ SLIME_PROVIDER: 'groq', GROQ_API_KEY: 'gsk_x' }), undefined);
    assert.equal(missingProviderKey({ SLIME_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'sk-x' }), undefined);
    assert.equal(missingProviderKey({ SLIME_PROVIDER: 'offline' }), undefined);
    assert.equal(missingProviderKey({ SLIME_PROVIDER: 'claude', SLIME_MODE: 'locked' }), undefined);
  });
});

describe('startupErrorMessage', () => {
  test('a connection refused by every address reads as the first address, not an empty AggregateError', () => {
    const refused = Object.assign(new AggregateError([new Error('connect ECONNREFUSED ::1:1'), new Error('connect ECONNREFUSED 127.0.0.1:1')], ''), {
      code: 'ECONNREFUSED',
    });
    assert.equal(startupErrorMessage(refused), 'connect ECONNREFUSED ::1:1');
  });

  test('keeps a plain message, falls back to the code, and stays on one line', () => {
    assert.equal(startupErrorMessage(new Error('password authentication failed for user "x"')), 'password authentication failed for user "x"');
    assert.equal(startupErrorMessage(Object.assign(new Error(''), { code: 'ENOTFOUND' })), 'ENOTFOUND');
    assert.equal(startupErrorMessage(new Error('line one\n  line two')), 'line one line two');
    assert.equal(startupErrorMessage('boom'), 'boom');
  });
});
