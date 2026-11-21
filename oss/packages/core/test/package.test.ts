// Guards the package's shape: the decisions in PLAN.md §3 that a later change
// could silently break (ESM only, Node 22+, one public entry, compiled output).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('is ESM-only and requires Node 22 or newer (C3)', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=22');
});

test('publishes compiled JS and types from dist/, not TypeScript sources (C8)', () => {
  assert.deepEqual(pkg.exports['.'], { types: './dist/index.d.ts', default: './dist/index.js' });
  assert.deepEqual(pkg.files, ['dist', 'README.md']);
});

test('stays private until go-public, so nothing is published by accident', () => {
  assert.equal(pkg.private, true);
});

test('the public entry exports createSlime, the config, the stores and errors, and nothing internal', async () => {
  const api = await import('../src/index.js');
  assert.deepEqual(Object.keys(api).sort(), [
    'DEFAULT_LIMITS',
    'DEFAULT_STORE_DIR',
    'DEFAULT_TIERS',
    'SlimeConfig',
    'SlimeConfigError',
    'SlimeError',
    'createSlime',
    'fileStore',
    'memoryStore',
  ]);
});

test('adapters have their own subpaths, so the main entry never loads them (C7)', async () => {
  assert.deepEqual(pkg.exports['./offline'], { types: './dist/offline/index.d.ts', default: './dist/offline/index.js' });
  assert.deepEqual(pkg.exports['./postgres'], { types: './dist/postgres/index.d.ts', default: './dist/postgres/index.js' });
  assert.deepEqual(Object.keys(await import('../src/offline/index.js')), ['offlineGenerator']);
  assert.deepEqual(Object.keys(await import('../src/postgres/index.js')), ['postgresConnector']);
});

test('database drivers are optional peer dependencies (C7)', () => {
  assert.equal(pkg.peerDependencies.pg, pkg.devDependencies.pg);
  assert.deepEqual(pkg.peerDependenciesMeta.pg, { optional: true });
  assert.equal(pkg.dependencies.pg, undefined);
});
