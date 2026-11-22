import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderServiceTypes, serviceNameFor, serviceNames } from '../../src/crystallize/services.js';
import type { Manifest, ManifestEntry } from '../../src/crystallize/manifest.js';

function entry(overrides: Partial<ManifestEntry>): ManifestEntry {
  return {
    file: 'k.mjs',
    sha256: 'x',
    intent: 'number of accounts on each plan',
    output: [{ plan: 'string', accounts: 'integer' }],
    paramTypes: {},
    schemaHash: 's',
    review: 'approved',
    isOptimized: false,
    notes: [],
    provenance: { schemaHash: 's', dictionaryHash: 'd', promptHash: 'p', model: 'm' },
    createdAt: '2026-11-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('service names', () => {
  test('are the first words of the intent in camelCase', () => {
    assert.equal(serviceNameFor('top N accounts by total paid invoice amount in cents', 'abc', new Set()), 'topNAccountsByTotalPaid');
  });

  test('get the key prefix when taken, reserved, empty or not an identifier', () => {
    assert.equal(serviceNameFor('number of accounts on each plan', 'abcdef0123', new Set(['numberOfAccountsOnEachPlan'])), 'numberOfAccountsOnEachPlan_abcdef01');
    assert.equal(serviceNameFor('delete', 'abcdef0123', new Set()), 'crystal_abcdef01');
    assert.equal(serviceNameFor('2024 revenue', 'abcdef0123', new Set()), 'crystal_abcdef01');
    assert.equal(serviceNameFor('', 'abcdef0123', new Set()), 'crystal_abcdef01');
  });

  test('a name in the manifest never changes when another Crystal would derive it', () => {
    const manifest: Manifest = { version: 1, entries: { b: entry({ service: 'numberOfAccountsOnEachPlan' }), a: entry({}) } };
    const names = serviceNames(manifest);
    assert.equal(names.get('b'), 'numberOfAccountsOnEachPlan');
    assert.equal(names.get('a'), 'numberOfAccountsOnEachPlan_a');
  });
});

describe('service types', () => {
  test('inputs are optional and nullable; a top-level object may be null; leaves map to TypeScript', () => {
    const manifest: Manifest = {
      version: 1,
      entries: {
        k: entry({ service: 'planSummary', paramTypes: { plan: 'string', ids: 'list', since: null }, output: { plan: 'string', mrr: 'number|null', since: 'date', top: [{ name: 'string', active: 'boolean' }] } }),
      },
    };
    assert.match(
      renderServiceTypes(manifest),
      /planSummary\(connector: Connector, input: \{ "plan"\?: string \| null; "ids"\?: Array<string \| number \| boolean \| null> \| null; "since"\?: string \| number \| boolean \| Array<string \| number \| boolean \| null> \| null \}, options\?: CrystalServiceOptions\): Promise<\{ "plan": string; "mrr": number \| null; "since": string; "top": Array<\{ "name": string; "active": boolean \}> \} \| null>/,
    );
  });

  test('a Crystal with no input takes none', () => {
    assert.match(renderServiceTypes({ version: 1, entries: { k: entry({ service: 'plans' }) } }), /plans\(connector: Connector, input\?: Record<string, never>/);
  });

  test('an intent cannot close the doc comment', () => {
    assert.doesNotMatch(renderServiceTypes({ version: 1, entries: { k: entry({ service: 's', intent: 'a */ evil' }) } }), /a \*\/ evil/);
  });
});
