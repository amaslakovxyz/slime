// Password hashing and session tokens: pure crypto, no DynamoDB.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hashPassword, signSession, verifyPassword, verifySession } from '../lib/auth';
import { env } from '../lib/env';

process.env.SESSION_SECRET ??= 'test-secret-that-is-at-least-32-characters';
const future = () => Math.floor(Date.now() / 1000) + 3600;

describe('passwords', () => {
  test('a hash verifies its own password and rejects another', async () => {
    const stored = await hashPassword('password123');
    assert.match(stored, /^scrypt\$[\w-]+\$[\w-]+$/);
    assert.equal(await verifyPassword('password123', stored), true);
    assert.equal(await verifyPassword('password124', stored), false);
  });

  test('a malformed stored hash never verifies', async () => {
    assert.equal(await verifyPassword('password123', 'scrypt$abc'), false);
    assert.equal(await verifyPassword('password123', 'plain$abc$def'), false);
  });
});

describe('sessions', () => {
  test('a signed session verifies', () => {
    const exp = future();
    assert.deepEqual(verifySession(signSession({ email: 'a@b.c', exp })), { email: 'a@b.c', exp });
  });

  test('a tampered payload or signature is rejected', () => {
    const [body, sig] = signSession({ email: 'a@b.c', exp: future() }).split('.');
    const forged = Buffer.from(JSON.stringify({ email: 'admin@b.c', exp: future() })).toString('base64url');
    assert.equal(verifySession(`${forged}.${sig}`), null);
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    assert.equal(verifySession(`${body}.${flipped}`), null);
    assert.equal(verifySession(`${body}.${sig}.extra`), null);
    assert.equal(verifySession('garbage'), null);
  });

  test('an expired session is rejected', () => {
    assert.equal(verifySession(signSession({ email: 'a@b.c', exp: Math.floor(Date.now() / 1000) - 1 })), null);
  });

  test('a session signed with another secret is rejected', () => {
    const token = signSession({ email: 'a@b.c', exp: future() });
    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'another-secret-that-is-at-least-32-chars';
    try {
      assert.equal(verifySession(token), null);
    } finally {
      process.env.SESSION_SECRET = saved;
    }
  });
});

describe('env', () => {
  test('refuses a session secret shorter than 32 characters', () => {
    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'x'.repeat(31);
    try {
      assert.throws(() => env(), /SESSION_SECRET/);
      process.env.SESSION_SECRET = 'x'.repeat(32);
      assert.equal(env().sessionSecret.length, 32);
    } finally {
      process.env.SESSION_SECRET = saved;
    }
  });
});
