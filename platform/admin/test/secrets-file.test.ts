// The file secret store under concurrent use (the runner and the admin both do this).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { secretStore } from '../lib/secrets';

describe('file secret store', () => {
  let file: string;
  beforeEach(() => {
    process.env.SESSION_SECRET = 'x'.repeat(32);
    process.env.SLIME_SECRETS = 'file';
    file = join(mkdtempSync(join(tmpdir(), 'slime-sec-')), 'secrets.json');
    process.env.SLIME_SECRETS_FILE = file;
  });

  test('parallel puts and removes lose nothing and leave valid JSON', async () => {
    const store = secretStore();
    await Promise.all(Array.from({ length: 30 }, (_, i) => store.put(`ep-${i}`, 'SLIME_API_KEY', `k${i}`)));
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => store.removeAll(`ep-${i}`)),
      ...Array.from({ length: 10 }, (_, i) => store.put(`ep-${i + 30}`, 'SLIME_API_KEY', `k${i + 30}`)),
    ]);
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    assert.equal(Object.keys(data).length, 30);
    assert.equal(await store.get('ep-0', 'SLIME_API_KEY'), undefined);
    assert.equal(await store.get('ep-39', 'SLIME_API_KEY'), 'k39');
  });

  test('a corrupt file fails without echoing its contents', async () => {
    writeFileSync(file, '{"/slime/endpoints/ep-1/SLIME_API_KEY": "slm_super_secret_val');
    await assert.rejects(secretStore().get('ep-1', 'SLIME_API_KEY'), (err: Error) => {
      assert.match(err.message, /is not valid JSON/);
      assert.doesNotMatch(err.message, /super_secret/);
      return true;
    });
  });

  test('a failed put does not block the next one', async () => {
    const store = secretStore();
    await store.put('ep-1', 'A', '1');
    await assert.rejects(store.put('ep-1', 'A', '2'), /already exists/);
    await store.put('ep-1', 'B', '3');
    assert.equal(await store.get('ep-1', 'B'), '3');
  });
});
