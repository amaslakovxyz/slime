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

test('the public entry exports createSlime, the config, the stores, the sandbox runner and errors, and nothing internal', async () => {
  const api = await import('../src/index.js');
  assert.deepEqual(Object.keys(api).sort(), [
    'DEFAULT_LIMITS',
    'DEFAULT_STORE_DIR',
    'DEFAULT_TIERS',
    'QuickJSRunner',
    'SlimeConfig',
    'SlimeConfigError',
    'SlimeError',
    'SourceError',
    'changedProvenance',
    'createSlime',
    'crystalService',
    'defineApiSource',
    'fileStore',
    'handlerKeyFor',
    'memoryStore',
  ]);
});

test('adapters have their own subpaths, so the main entry never loads them (C7)', async () => {
  assert.equal(pkg.exports['./offline'], undefined, 'canned handlers are a test double: @slime-cloud/core/testing');
  assert.deepEqual(pkg.exports['./postgres'], { types: './dist/sources/sql/postgres/index.d.ts', default: './dist/sources/sql/postgres/index.js' });
  assert.deepEqual(Object.keys(await import('../src/sources/sql/postgres/index.js')), ['postgresConnector']);
  for (const provider of ['claude', 'groq'] as const) {
    assert.deepEqual(pkg.exports[`./${provider}`], { types: `./dist/models/${provider}/index.d.ts`, default: `./dist/models/${provider}/index.js` });
  }
  assert.deepEqual(Object.keys(await import('../src/models/claude/index.js')).sort(), ['claude']);
  assert.deepEqual(Object.keys(await import('../src/models/groq/index.js')).sort(), ['groq']);
  assert.deepEqual(pkg.exports['./notion'], { types: './dist/sources/api/notion/index.d.ts', default: './dist/sources/api/notion/index.js' });
  assert.deepEqual(Object.keys(await import('../src/sources/api/notion/index.js')).sort(), ['NOTION_VERSION', 'notionSource']);
  assert.deepEqual(pkg.exports['./models'], { types: './dist/models/index.d.ts', default: './dist/models/index.js' });
  assert.deepEqual(Object.keys(await import('../src/models/index.js')).sort(), ['modelRoles', 'parseJsonReply', 'providerRoles']);
  assert.equal(pkg.exports['./crystallize'], undefined, 'the crystallize job is @slime-cloud/crystal');
  assert.deepEqual(pkg.exports['./tooling'], { types: './dist/tooling.d.ts', default: './dist/tooling.js' });
  assert.deepEqual(Object.keys(await import('../src/tooling.js')).sort(), ['HANDLERS_NS', 'SQL_SOURCE_DEFAULT_NAME', 'asSingleQuery', 'assertReadOnlySql', 'bindParams', 'canonicalJSON', 'executeArtifact', 'isApiStep', 'paramTypesForModel', 'queryLimits', 'recordFromStore', 'runCrystal', 'sha256']);
  assert.deepEqual(pkg.exports['./testing'], { types: './dist/testing/index.d.ts', default: './dist/testing/index.js' });
  assert.deepEqual(Object.keys(await import('../src/testing/index.js')).sort(), [
    'FAKE_SECRET',
    'artifact',
    'cannedGenerator',
    'describeApiSourceContract',
    'describeConnectorContract',
    'describeModelClientContract',
    'describeStoreContract',
    'fakeApiSource',
    'fakeConnector',
    'fakeGenerator',
    'fakeReviewer',
    'fixtureFetch',
    'fixtureKey',
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

test('ships no bin: slime-crystal is @slime-cloud/crystal (C10)', () => {
  assert.equal(pkg.bin, undefined);
});
