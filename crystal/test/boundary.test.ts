// Crystal reaches core only through its package entries, so it builds and ships
// against core's dist/ like any other consumer; never through core's sources.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const SRC = new URL('../src/', import.meta.url).pathname;
const CORE_ENTRIES = new Set(['@slime-cloud/core', '@slime-cloud/core/tooling', '@slime-cloud/core/postgres']);
const IMPORT = /(?:from|import\()\s*'([^']+)'/g;

test('src/ imports core only through its public and tooling entries', () => {
  const violations = readdirSync(SRC)
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) => [...readFileSync(join(SRC, file), 'utf8').matchAll(IMPORT)].map(([, specifier]) => ({ file, specifier: specifier ?? '' })))
    .filter(({ specifier }) => (specifier.startsWith('@slime-cloud/') && !CORE_ENTRIES.has(specifier)) || specifier.includes('core/src'))
    .map(({ file, specifier }) => `${file} imports ${specifier}`);
  assert.deepEqual(violations, []);
});
