import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importCheckedModule } from '../src/import-module.js';

const MODULE = 'export const sql = "SELECT 1 AS one";\nexport const params = [];\nexport function shape(rows) { return rows; }\n';

test('the same module imported many times at once never loses its temporary copy', async () => {
  const imports = await Promise.all(Array.from({ length: 20 }, () => importCheckedModule(MODULE)));
  assert.ok(imports.every((code) => 'sql' in code && code.sql === 'SELECT 1 AS one'));
});
