// The SlimeStore contract (C13). Every store, built in or custom, must pass it.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SlimeStore } from '../stores/types.js';

export type StoreFactory = () => SlimeStore | Promise<SlimeStore>;

const NS = 'handlers';

export function describeStoreContract(storeName: string, createStore: StoreFactory): void {
  describe(`${storeName} store: SlimeStore contract (C13)`, () => {
    test('get returns undefined for a missing key', async () => {
      assert.equal(await (await createStore()).get(NS, 'missing'), undefined);
    });

    test('put then get round-trips a JSON value, and put replaces it', async () => {
      const store = await createStore();
      await store.put(NS, 'a1', { runs: 1, tags: ['x'], note: null });
      assert.deepEqual(await store.get(NS, 'a1'), { runs: 1, tags: ['x'], note: null });
      await store.put(NS, 'a1', { runs: 2 });
      assert.deepEqual(await store.get(NS, 'a1'), { runs: 2 });
    });

    test('a value read back is a copy: changing it changes nothing stored', async () => {
      const store = await createStore();
      await store.put(NS, 'a1', { runs: 1 });
      const readBack = (await store.get(NS, 'a1')) as { runs: number };
      readBack.runs = 99;
      assert.deepEqual(await store.get(NS, 'a1'), { runs: 1 });
    });

    test('list returns the entries whose key starts with the prefix, or all of them', async () => {
      const store = await createStore();
      await store.put(NS, 'ab1', 1);
      await store.put(NS, 'ab2', 2);
      await store.put(NS, 'cd1', 3);
      const keysOf = async (prefix?: string) => (await store.list(NS, prefix)).map(({ key }) => key).sort();
      assert.deepEqual(await keysOf('ab'), ['ab1', 'ab2']);
      assert.deepEqual(await keysOf(), ['ab1', 'ab2', 'cd1']);
      assert.deepEqual(await store.list(NS, 'ab1'), [{ key: 'ab1', value: 1 }]);
    });

    test('namespaces are separate', async () => {
      const store = await createStore();
      await store.put(NS, 'a1', 'handler');
      await store.put('other', 'a1', 'other');
      assert.equal(await store.get(NS, 'a1'), 'handler');
      assert.deepEqual(await store.list('empty'), []);
    });

    test('delete removes a key, and deleting a missing key is not an error', async () => {
      const store = await createStore();
      await store.put(NS, 'a1', 1);
      await store.delete(NS, 'a1');
      await store.delete(NS, 'never-there');
      assert.equal(await store.get(NS, 'a1'), undefined);
    });
  });
}
