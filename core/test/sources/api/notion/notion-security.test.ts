// S6 and S8 over the Notion adapter (P5.6): what reaches the model's dictionary,
// and that Notion row text never reaches a prompt, repairs included.
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { SlimeConfig } from '../../../../src/config/slime-config.js';
import { createSlime } from '../../../../src/create-slime.js';
import type { Slime } from '../../../../src/engine/types.js';
import type { Artifact } from '../../../../src/artifact/artifact.js';
import type { GenerationRequest } from '../../../../src/models/types.js';
import { notionSource } from '../../../../src/sources/api/notion/notion-source.js';
import { memoryStore } from '../../../../src/stores/memory-store.js';
import { fixtureFetch } from '../../../../src/testing/fixture-fetch.js';
import { fakeConnector, stubGenerator } from '../../../../src/testing/fakes.js';

const DATA_SOURCE = '1f2e3d4c-5b6a-4789-8abc-def012345678';
const SEEDED_TEXT = ['Export is slow', 'Love the dashboard', 'Sync fails', 'Globex'];
const fixtures = fixtureFetch(new URL('../../../fixtures/notion-handwritten/', import.meta.url));
const notion = () => notionSource({ token: 'ntn_secret', dataSources: { feedback: DATA_SOURCE }, exclude: { feedback: ['Internal notes'] }, fetchImpl: fixtures });

const instances: Slime[] = [];
after(() => Promise.all(instances.map((slime) => slime.close())));

function handler(shapeJs: string): Artifact {
  return {
    version: 2,
    unsatisfiable: null,
    steps: [
      { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts', params: [] },
      { name: 'feedback', source: 'notion', operation: 'feedback.query', args: [] },
    ],
    shapeJs,
    assumptions: [],
  };
}

describe('Notion and the model (S6, S8)', () => {
  test('the dictionary has no people column and no excluded property (S6)', async () => {
    const requests: GenerationRequest[] = [];
    const slime = await createSlime(new SlimeConfig({ sources: { db: fakeConnector({ rows: [{ name: 'Acme' }] }), notion: notion() }, store: memoryStore(), generator: stubGenerator((request) => (requests.push(request), handler('function shape(data) { return []; }'))) }));
    instances.push(slime);
    await slime.query({ intent: 'nothing', output: [{ name: 'string' }] });
    const context = requests[0]?.context ?? '';
    assert.match(context, /Operation feedback\.query/);
    for (const hidden of ['Owner', 'owner', 'Internal notes', 'internalNotes']) assert.ok(!context.includes(hidden), `${hidden} reached the dictionary`);
  });

  test('no Notion row text reaches any prompt, even through a forced repair (S8)', async () => {
    const requests: GenerationRequest[] = [];
    // The first handler puts row text where a number belongs, so the run fails with SHAPE_MISMATCH and is repaired.
    const broken = handler('function shape(data) { return data.feedback.map((f) => ({ name: f.title, open: f.title })); }');
    const fixed = handler('function shape(data) { return data.accounts.map((a) => ({ name: a.name, open: data.feedback.filter((f) => f.account === a.name).length })); }');
    const generator = stubGenerator((request) => (requests.push(structuredClone(request)), request.previous ? fixed : broken));
    const slime = await createSlime(new SlimeConfig({ sources: { db: fakeConnector({ rows: [{ name: 'Acme' }] }), notion: notion() }, store: memoryStore(), generator }));
    instances.push(slime);
    const { data } = await slime.query({ intent: 'accounts with their feedback count', output: [{ name: 'string', open: 'integer' }] });
    assert.deepEqual(data, [{ name: 'Acme', open: 2 }]);
    assert.equal(requests.length, 2, 'the repair ran');
    assert.match(requests[1]?.previous?.error ?? '', /^SHAPE_MISMATCH: .*expected integer, got a string/);
    const everything = JSON.stringify(requests);
    for (const text of SEEDED_TEXT) assert.ok(!everything.includes(text), `"${text}" reached a prompt`);
  });
});
