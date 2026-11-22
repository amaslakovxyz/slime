import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isApiStep, type Artifact } from '../../src/artifact/artifact.js';
import { ArtifactSchema } from '../../src/models/schemas.js';

const V2: Artifact = {
  version: 2,
  unsatisfiable: null,
  steps: [
    { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts WHERE plan = $1::text', params: ['plan'] },
    { name: 'feedback', source: 'notion', operation: 'feedback.query', args: [{ param: 'sentiment', input: null, value: 'negative' }] },
  ],
  shapeJs: 'function shape(data, input) { return data.accounts; }',
  assumptions: [],
};

describe('the artifact schema (MS4)', () => {
  test('accepts a two-step artifact', () => {
    assert.deepEqual(ArtifactSchema.parse(V2), V2);
  });

  test('refuses extra keys, a wrong version and a map of args', () => {
    assert.throws(() => ArtifactSchema.parse({ ...V2, extra: 1 }));
    assert.throws(() => ArtifactSchema.parse({ ...V2, version: 1 }));
    assert.throws(() => ArtifactSchema.parse({ ...V2, steps: [{ name: 'f', source: 'notion', operation: 'x', args: { sentiment: 'negative' } }] }));
  });

  test('accepts both input and value set: the schema allows it, lint refuses it', () => {
    const both = { ...V2, steps: [{ name: 'f', source: 'notion', operation: 'x', args: [{ param: 'p', input: 'a', value: 'b' }] }] };
    assert.doesNotThrow(() => ArtifactSchema.parse(both));
  });

  test('tells SQL steps from API steps', () => {
    assert.deepEqual(V2.steps.map(isApiStep), [false, true]);
  });
});
