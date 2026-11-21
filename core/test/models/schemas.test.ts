import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isApiStep, isArtifactV2, type ArtifactV2 } from '../../src/models/artifact-v2.js';
import { ArtifactV2Schema } from '../../src/models/schemas.js';
import { artifact } from '../../src/testing/fakes.js';

const V2: ArtifactV2 = {
  version: 2,
  unsatisfiable: null,
  steps: [
    { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts WHERE plan = $1::text', params: ['plan'] },
    { name: 'feedback', source: 'notion', operation: 'feedback.query', args: [{ param: 'sentiment', input: null, value: 'negative' }] },
  ],
  shapeJs: 'function shape(data, input) { return data.accounts; }',
  assumptions: [],
};

describe('the v2 artifact schema (MS3, MS4)', () => {
  test('accepts a two-step artifact', () => {
    assert.deepEqual(ArtifactV2Schema.parse(V2), V2);
  });

  test('refuses extra keys, a wrong version and a map of args', () => {
    assert.throws(() => ArtifactV2Schema.parse({ ...V2, extra: 1 }));
    assert.throws(() => ArtifactV2Schema.parse({ ...V2, version: 1 }));
    assert.throws(() => ArtifactV2Schema.parse({ ...V2, steps: [{ name: 'f', source: 'notion', operation: 'x', args: { sentiment: 'negative' } }] }));
  });

  test('accepts both input and value set: the schema allows it, lint refuses it', () => {
    const both = { ...V2, steps: [{ name: 'f', source: 'notion', operation: 'x', args: [{ param: 'p', input: 'a', value: 'b' }] }] };
    assert.doesNotThrow(() => ArtifactV2Schema.parse(both));
  });

  test('guards tell v1 from v2 and SQL steps from API steps', () => {
    assert.equal(isArtifactV2(V2), true);
    assert.equal(isArtifactV2(artifact('SELECT 1')), false);
    assert.deepEqual(V2.steps.map(isApiStep), [false, true]);
  });
});
