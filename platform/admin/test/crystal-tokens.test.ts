// Crystal tokens in the endpoint's secrets (file store in tests).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { crystalToken, crystalTokenHints, issueCrystalTokens } from '../lib/crystal-tokens';

describe('crystal tokens', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = 'x'.repeat(32);
    process.env.SLIME_SECRETS = 'file';
    process.env.SLIME_SECRETS_FILE = join(mkdtempSync(join(tmpdir(), 'slime-ct-')), 'secrets.json');
  });

  test('issues one token per new key and keeps existing ones', async () => {
    assert.deepEqual(await issueCrystalTokens('ep-1', ['k1']), ['k1']);
    const first = await crystalToken('ep-1', 'k1');
    assert.match(first ?? '', /^slc_[\w-]{32}$/);
    assert.deepEqual(await issueCrystalTokens('ep-1', ['k1', 'k2']), ['k2']);
    assert.equal(await crystalToken('ep-1', 'k1'), first);
    assert.notEqual(await crystalToken('ep-1', 'k2'), first);
  });

  test('hints expose only the last four characters, per endpoint', async () => {
    await issueCrystalTokens('ep-1', ['k1']);
    const hints = await crystalTokenHints('ep-1');
    assert.equal(hints.k1, (await crystalToken('ep-1', 'k1'))?.slice(-4));
    assert.deepEqual(await crystalTokenHints('ep-2'), {});
  });
});
