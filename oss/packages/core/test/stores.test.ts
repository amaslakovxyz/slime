import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileStore } from '../src/store/file-store.js';
import { memoryStore } from '../src/store/memory-store.js';
import { describeStoreContract } from './store-contract.js';

const temporaryDirs: string[] = [];
after(() => Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slime-store-'));
  temporaryDirs.push(dir);
  return dir;
}

describeStoreContract('memory', memoryStore);
describeStoreContract('file', async () => fileStore(await temporaryDir()));

describe('file store rules (§4.7)', () => {
  test('keeps one JSON file per key and leaves no temporary files', async () => {
    const dir = await temporaryDir();
    await fileStore(dir).put('handlers', 'abc', { runs: 1 });
    assert.deepEqual(await readdir(join(dir, 'handlers')), ['abc.json']);
  });

  test('refuses keys that are not safe file names', async () => {
    const store = fileStore(await temporaryDir());
    await assert.rejects(store.put('handlers', '../escape', 1), /not a safe file name/);
    await assert.rejects(store.get('../handlers', 'a'), /not a safe file name/);
  });
});
