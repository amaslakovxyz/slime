// A Crystal made from a multi-step handler: SQL and API steps in parallel, then
// shape(data, input), through the engine and as a service the app calls.
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { SlimeConfig, type SlimeOptions } from '../../src/config/slime-config.js';
import { createSlime } from '../../src/create-slime.js';
import { crystalService } from '../../src/engine/crystal/service.js';
import type { Slime } from '../../src/engine/types.js';
import type { CrystalRegistry, StepsCrystal } from '../../src/handler/crystal.js';
import type { Step } from '../../src/artifact/artifact.js';
import { requestKey } from '../../src/request/key.js';
import { parseRequest } from '../../src/request/parse.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import type { ApiSource } from '../../src/sources/api/types.js';
import { fakeApiSource, type FakeApiSource } from '../../src/testing/fake-api-source.js';
import { fakeConnector, stubGenerator } from '../../src/testing/fakes.js';

const REQUEST = { intent: 'accounts on a plan with their open negative feedback', input: { plan: 'Pro' }, output: [{ name: 'string', open: 'integer' }] };
const KEY = requestKey(parseRequest(REQUEST));
const STEPS: Step[] = [
  { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts WHERE plan = $1::text', params: ['plan'] },
  { name: 'feedback', source: 'notion', operation: 'feedback.query', args: [{ param: 'sentiment', input: null, value: 'negative' }] },
];
const SHAPE_SOURCE = 'function shape(data) { return data.accounts.map((a) => ({ name: a.name, open: data.feedback.filter((f) => f.account === a.name).length })); }';
const ROWS = [{ name: 'Acme' }, { name: 'Globex' }];
const EXPECTED = [
  { name: 'Acme', open: 2 },
  { name: 'Globex', open: 0 },
];

function notion(): FakeApiSource & { describes: number } {
  const source = fakeApiSource({
    name: 'notion',
    operations: {
      'feedback.query': {
        params: [{ name: 'sentiment', type: 'string' }],
        columns: [{ name: 'account', type: 'string', nullable: true }],
        rows: [{ account: 'Acme' }, { account: 'Acme' }],
      },
    },
  });
  const describe = source.describe.bind(source);
  let describes = 0;
  source.describe = (options: Parameters<ApiSource['describe']>[0]) => {
    describes++;
    return describe(options);
  };
  return Object.defineProperty(source, 'describes', { get: () => describes }) as FakeApiSource & { describes: number };
}

function crystal(shape: StepsCrystal['shape'], steps: Step[] = STEPS): StepsCrystal {
  return { steps, shape, intent: REQUEST.intent, output: REQUEST.output, paramTypes: { plan: 'string' }, schemaHash: 'schema', review: 'approved' };
}

const instances: Slime[] = [];
after(() => Promise.all(instances.map((slime) => slime.close())));

async function slimeWith(registry: CrystalRegistry, options: Partial<SlimeOptions> = {}): Promise<Slime> {
  const sources = { db: fakeConnector({ rows: ROWS }), notion: notion() };
  const slime = await createSlime(new SlimeConfig({ sources, store: memoryStore(), generator: stubGenerator(() => ({ version: 2, unsatisfiable: null, steps: STEPS, shapeJs: SHAPE_SOURCE, assumptions: [] })), crystal: registry, ...options }));
  instances.push(slime);
  return slime;
}

describe('a steps Crystal in the engine', () => {
  test('answers with its steps and a function shape, with each step in meta', async () => {
    const shape = (data: Record<string, Record<string, unknown>[]>) => data['accounts']!.map((a) => ({ name: a['name'], open: data['feedback']!.filter((f) => f['account'] === a['name']).length }));
    const result = await (await slimeWith({ [KEY]: crystal(shape) })).query(REQUEST);
    assert.deepEqual(result.data, EXPECTED);
    assert.equal(result.meta.tier, 'crystal');
    assert.deepEqual(result.meta.steps?.map(({ name, source }) => [name, source]), [['accounts', 'db'], ['feedback', 'notion']]);
    assert.match(result.meta.sql ?? '', /FROM accounts/);
  });

  test('a shape loaded as source text runs in the sandbox and answers the same', async () => {
    const result = await (await slimeWith({ [KEY]: crystal(SHAPE_SOURCE) })).query(REQUEST);
    assert.deepEqual([result.data, result.meta.tier], [EXPECTED, 'crystal']);
  });

  test('an API operation that is gone falls back to a generated handler', async () => {
    const gone: Step[] = [STEPS[0]!, { ...(STEPS[1] as Step), operation: 'feedback.removed' } as Step];
    const warnings: string[] = [];
    const slime = await slimeWith({ [KEY]: crystal(SHAPE_SOURCE, gone) }, { onEvent: (event) => event.type === 'warning' && warnings.push(event.message) });
    const result = await slime.query(REQUEST);
    assert.deepEqual([result.data, result.meta.tier], [EXPECTED, 'gas']);
    assert.ok(warnings.some((message) => /falls back: INVALID_HANDLER/.test(message)), warnings.join('\n'));
  });
});

describe('a steps Crystal as a service', () => {
  const shape = (data: Record<string, Record<string, unknown>[]>) => data['accounts']!.map((a) => ({ name: a['name'], open: data['feedback']!.filter((f) => f['account'] === a['name']).length }));

  test('runs with the app\'s sources, and describes each API source once', async () => {
    const service = crystalService(crystal(shape));
    const sources = { db: fakeConnector({ rows: ROWS }), notion: notion() };
    assert.deepEqual(await service(sources, { plan: 'Pro' }), EXPECTED);
    assert.deepEqual(await service(sources, { plan: 'Pro' }), EXPECTED);
    assert.equal(sources.notion.describes, 1);
  });

  test('with the connector alone, it says which API source it needs', async () => {
    const service = crystalService(crystal(shape));
    await assert.rejects(service(fakeConnector({ rows: ROWS }), { plan: 'Pro' }), (error: Error & { code?: string }) => error.code === 'INVALID_REQUEST' && /"notion"/.test(error.message));
  });

  test('a sources map with no SQL connector is a programming error', async () => {
    const service = crystalService(crystal(shape));
    await assert.rejects(service({ notion: notion() }, { plan: 'Pro' }), TypeError);
  });
});
