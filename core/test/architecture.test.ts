// The folders of src/ import in one direction only, so the domain (artifact,
// handler) and the ports (sources, models, stores, sandbox) never depend on the
// engine that uses them. A new edge is a design decision: add it here on purpose.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { test } from 'node:test';

const SRC = new URL('../src/', import.meta.url).pathname;
const RELATIVE_IMPORT = /from '(\.[^']+)'/g;

const BELOW_ENGINE = ['shared', 'request', 'sources', 'artifact', 'handler', 'models', 'stores', 'sandbox', 'dictionary', 'config'];
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  shared: [],
  request: ['shared'],
  sandbox: ['shared'],
  stores: ['shared'],
  sources: ['shared', 'request'],
  artifact: ['shared', 'request', 'sources'],
  handler: ['shared', 'request', 'sources', 'artifact'],
  models: ['shared', 'request', 'artifact'],
  dictionary: ['shared', 'sources'],
  config: ['shared', 'sources', 'artifact', 'handler', 'models', 'stores'],
  testing: BELOW_ENGINE,
  engine: BELOW_ENGINE,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function topFolder(path: string): string {
  return relative(SRC, path).split('/')[0] ?? '';
}

test('src/ folders import only the folders below them', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const from = topFolder(file);
    const allowed = ALLOWED[from];
    if (!allowed) continue; // the composition root: create-slime.ts, index.ts
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) {
      const to = topFolder(normalize(join(dirname(file), specifier ?? '')));
      if (to !== from && !allowed.includes(to)) violations.push(`${relative(SRC, file)} imports ${to}/`);
    }
  }
  assert.deepEqual(violations, []);
});

test('every src/ folder has a rule', () => {
  const folders = readdirSync(SRC, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.deepEqual(folders.filter((folder) => !(folder in ALLOWED)), []);
});
