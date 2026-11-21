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
    'handlerKeyFor',
    'memoryStore',
  ]);
});

test('adapters have their own subpaths, so the main entry never loads them (C7)', async () => {
  assert.deepEqual(pkg.exports['./offline'], { types: './dist/models/offline/index.d.ts', default: './dist/models/offline/index.js' });
  assert.deepEqual(pkg.exports['./postgres'], { types: './dist/connectors/postgres/index.d.ts', default: './dist/connectors/postgres/index.js' });
  assert.deepEqual(Object.keys(await import('../src/models/offline/index.js')), ['offlineGenerator']);
  assert.deepEqual(Object.keys(await import('../src/connectors/postgres/index.js')), ['postgresConnector']);
  for (const provider of ['claude', 'groq'] as const) {
    assert.deepEqual(pkg.exports[`./${provider}`], { types: `./dist/models/${provider}/index.d.ts`, default: `./dist/models/${provider}/index.js` });
  }
  assert.deepEqual(Object.keys(await import('../src/models/claude/index.js')).sort(), ['claude', 'claudeGenerator', 'claudeOptimizer', 'claudeReviewer']);
  assert.deepEqual(Object.keys(await import('../src/models/groq/index.js')).sort(), ['groq', 'groqGenerator', 'groqOptimizer', 'groqReviewer']);
  assert.deepEqual(pkg.exports['./crystallize'], { types: './dist/crystallize/index.d.ts', default: './dist/crystallize/index.js' });
  assert.deepEqual(pkg.exports['./testing'], { types: './dist/testing/index.d.ts', default: './dist/testing/index.js' });
  assert.deepEqual(Object.keys(await import('../src/testing/index.js')).sort(), [
    'artifact',
    'describeStoreContract',
    'fakeConnector',
    'fakeGenerator',
    'fakeReviewer',
    'stubGenerator',
    'stubReviewer',
  ]);
  // Bundlers copy the shaping worker by this name; it is never imported, only loaded as a worker.
  assert.equal(pkg.exports['./shape-worker'], './dist/sandbox/quickjs/shape-worker.js');
});

test('database drivers and model SDKs are optional peer dependencies (C7)', () => {
  for (const name of ['pg', '@anthropic-ai/sdk']) {
    assert.equal(pkg.peerDependencies[name], pkg.devDependencies[name], name);
    assert.deepEqual(pkg.peerDependenciesMeta[name], { optional: true }, name);
    assert.equal(pkg.dependencies[name], undefined, name);
  }
});

test('ships the slime-crystal bin for the app\'s CI (C10)', () => {
  assert.deepEqual(pkg.bin, { 'slime-crystal': './dist/crystallize/bin.js' });
});
