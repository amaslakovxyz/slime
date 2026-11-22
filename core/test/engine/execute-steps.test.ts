// The v2 step executor (design §3.5, MS6, MS7) with a fake connector and fake API sources.
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { DEFAULT_LIMITS } from '../../src/config/defaults.js';
import type { Connector } from '../../src/sources/sql/types.js';
import { executeArtifact, type ExecutionDeps } from '../../src/engine/execute.js';
import type { ApiStep, Artifact, SqlStep } from '../../src/models/artifact.js';
import { QuickJSRunner } from '../../src/sandbox/quickjs/quickjs-runner.js';
import { SlimeError } from '../../src/shared/errors.js';
import type { ApiSchema, ApiSource } from '../../src/sources/api/types.js';
import { FAKE_SECRET, fakeApiSource, type FakeOperation } from '../../src/testing/fake-api-source.js';
import { fakeConnector } from '../../src/testing/fakes.js';

const runner = new QuickJSRunner();
after(() => runner.close());

const FEEDBACK_COLUMNS = [
  { name: 'account', type: 'string', nullable: true },
  { name: 'sentiment', type: 'string', nullable: true },
];
const FEEDBACK_PARAMS = [
  { name: 'sentiment', type: 'string' as const, values: ['positive', 'negative'] },
  { name: 'createdFrom', type: 'date' as const },
];
const FEEDBACK_ROWS = [
  { account: 'Acme', sentiment: 'negative' },
  { account: 'Acme', sentiment: 'negative' },
  { account: 'Globex', sentiment: 'negative' },
];
const ACCOUNTS = [{ name: 'Acme' }, { name: 'Globex' }, { name: 'Initech' }];
const SQL_STEP: SqlStep = { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts WHERE ($1::text IS NULL OR plan = $1::text)', params: ['plan'] };
const API_STEP: ApiStep = {
  name: 'feedback',
  source: 'notion',
  operation: 'feedback.query',
  args: [
    { param: 'sentiment', input: null, value: 'negative' },
    { param: 'createdFrom', input: 'since', value: null },
  ],
};
const SHAPE = 'function shape(data, input) { const open = new Map(); for (const f of data.feedback) open.set(f.account, (open.get(f.account) ?? 0) + 1); return data.accounts.map((a) => ({ name: a.name, open: open.get(a.name) ?? 0 })); }';
const ARTIFACT: Artifact = { version: 2, unsatisfiable: null, steps: [SQL_STEP, API_STEP], shapeJs: SHAPE, assumptions: [] };
const OUTPUT = [{ name: 'string', open: 'integer' }];
const INPUT = { plan: 'pro', since: null };

function feedbackOperation(overrides: Partial<FakeOperation> = {}): FakeOperation {
  return { params: FEEDBACK_PARAMS, columns: FEEDBACK_COLUMNS, rows: FEEDBACK_ROWS, ...overrides };
}

async function deps(apiSources: Record<string, ApiSource>, connector: Connector = fakeConnector({ rows: ACCOUNTS }), limits = {}): Promise<ExecutionDeps> {
  const signal = new AbortController().signal;
  const apiSchemas: Record<string, ApiSchema> = {};
  for (const [name, source] of Object.entries(apiSources)) apiSchemas[name] = await source.describe({ timeoutMs: 1_000, signal });
  return { connector, runner, limits: { ...DEFAULT_LIMITS, ...limits }, sources: { db: connector, ...apiSources }, apiSchemas };
}

function failingConnector(): Connector {
  return { ...fakeConnector(), run: async () => Promise.reject(new SlimeError('QUERY_ERROR', 'column "plan" does not exist')) };
}

describe('the step executor', () => {
  test('runs the steps and combines them in shape(data, input)', async () => {
    const notion = fakeApiSource({ operations: { 'feedback.query': feedbackOperation() } });
    const execution = await executeArtifact(await deps({ notion }), { artifact: ARTIFACT, output: OUTPUT, input: INPUT });
    assert.deepEqual(execution.data, [
      { name: 'Acme', open: 2 },
      { name: 'Globex', open: 1 },
      { name: 'Initech', open: 0 },
    ]);
    assert.deepEqual(notion.calls, [{ operation: 'feedback.query', args: { sentiment: 'negative', createdFrom: null } }]);
    assert.deepEqual(execution.steps?.map(({ name, source, rows }) => ({ name, source, rows })), [
      { name: 'accounts', source: 'db', rows: 3 },
      { name: 'feedback', source: 'notion', rows: 3 },
    ]);
  });

  test('starts every step before any finishes', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const first = fakeApiSource({ operations: { 'feedback.query': feedbackOperation({ gate: firstGate }) } });
    // The second source only runs if the first is still waiting, and it is what lets the first finish.
    const second = fakeApiSource({ operations: { 'feedback.query': feedbackOperation({ rows: () => (releaseFirst(), []) }) } });
    const artifact: Artifact = { ...ARTIFACT, steps: [API_STEP, { ...API_STEP, name: 'more', source: 'jira' }], shapeJs: 'function shape(data) { return []; }' };
    const execution = await executeArtifact(await deps({ notion: first, jira: second }), { artifact, output: OUTPUT, input: INPUT });
    assert.deepEqual(execution.data, []);
  });

  test('an API failure is a redacted SOURCE_ERROR and aborts the other API steps', async () => {
    let siblingSignal: AbortSignal | undefined;
    const failing = fakeApiSource({ operations: { 'feedback.query': feedbackOperation({ failWith: { status: 503, message: 'service down' } }) } });
    const sibling = fakeApiSource({ operations: { 'feedback.query': feedbackOperation({ gate: new Promise(() => {}) }) } });
    const originalCall = sibling.call.bind(sibling);
    sibling.call = (operation, args, options) => ((siblingSignal = options.signal), originalCall(operation, args, options));
    const artifact: Artifact = { ...ARTIFACT, steps: [{ ...API_STEP, name: 'other', source: 'jira' }, API_STEP] };
    await assert.rejects(executeArtifact(await deps({ notion: failing, jira: sibling }), { artifact, output: OUTPUT, input: INPUT }), (error: SlimeError) => {
      assert.equal(error.code, 'SOURCE_ERROR');
      assert.equal(error.retryable, true);
      assert.ok(!error.message.includes(FAKE_SECRET) && !JSON.stringify(error.toJSON()).includes(FAKE_SECRET));
      assert.deepEqual(error.details, { source: 'notion', operation: 'feedback.query', status: 503, attempts: 1 });
      return true;
    });
    assert.equal(siblingSignal?.aborted, true);
  });

  test('a client error from a source is not retryable', async () => {
    const notion = fakeApiSource({ operations: { 'feedback.query': feedbackOperation({ failWith: { status: 400, message: 'bad filter' } }) } });
    await assert.rejects(executeArtifact(await deps({ notion }), { artifact: ARTIFACT, output: OUTPUT, input: INPUT }), { code: 'SOURCE_ERROR', retryable: false });
  });

  test('a SQL failure stays QUERY_ERROR and aborts the API step', async () => {
    let apiSignal: AbortSignal | undefined;
    const notion = fakeApiSource({ operations: { 'feedback.query': feedbackOperation({ gate: new Promise(() => {}) }) } });
    const originalCall = notion.call.bind(notion);
    notion.call = (operation, args, options) => ((apiSignal = options.signal), originalCall(operation, args, options));
    await assert.rejects(executeArtifact(await deps({ notion }, failingConnector()), { artifact: ARTIFACT, output: OUTPUT, input: INPUT }), { code: 'QUERY_ERROR' });
    assert.equal(apiSignal?.aborted, true);
  });

  test('an input of the wrong type is refused on every run', async () => {
    const notion = fakeApiSource({ operations: { 'feedback.query': feedbackOperation() } });
    const run = async (since: unknown) => executeArtifact(await deps({ notion }), { artifact: ARTIFACT, output: OUTPUT, input: { plan: 'pro', since: since as string } });
    await assert.rejects(run('last week'), { code: 'INVALID_REQUEST', message: /Input "since" must be a date/ });
    await assert.rejects(run(['2026-01-01']), { code: 'INVALID_REQUEST' });
    await assert.doesNotReject(run('2026-01-01'));
  });

  test('a truncated step in a multi-step handler fails with QUERY_TOO_LARGE', async () => {
    const notion = fakeApiSource({ operations: { 'feedback.query': feedbackOperation() } });
    await assert.rejects(executeArtifact(await deps({ notion }, fakeConnector({ rows: ACCOUNTS }), { rowCap: 2 }), { artifact: ARTIFACT, output: OUTPUT, input: INPUT }), {
      code: 'QUERY_TOO_LARGE',
      details: { step: 'feedback' },
    });
  });

  test('a single step without shapeJs returns its rows, cut and flagged as today', async () => {
    const notion = fakeApiSource({ operations: { 'feedback.query': feedbackOperation() } });
    const artifact: Artifact = { ...ARTIFACT, steps: [API_STEP], shapeJs: null };
    const execution = await executeArtifact(await deps({ notion }, fakeConnector(), { rowCap: 2 }), { artifact, output: [{ account: 'string|null', sentiment: 'string|null' }], input: INPUT });
    assert.deepEqual(execution.data, FEEDBACK_ROWS.slice(0, 2));
    assert.equal(execution.truncated, true);
  });

  test('an API row that is not plain JSON is refused', async () => {
    const notion = fakeApiSource({ operations: { 'feedback.query': feedbackOperation({ rows: [{ account: 'Acme', sentiment: 1n }] }) } });
    await assert.rejects(executeArtifact(await deps({ notion }), { artifact: ARTIFACT, output: OUTPUT, input: INPUT }), { code: 'SOURCE_ERROR', message: /bigint/ });
  });
});
