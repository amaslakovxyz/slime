import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lintSteps, type StepLintContext } from '../../../src/engine/checks/steps.js';
import type { ApiStep, Artifact, SqlStep } from '../../../src/models/artifact.js';
import type { ApiSchema } from '../../../src/sources/api/types.js';

const NOTION: ApiSchema = {
  service: 'Notion',
  operations: [
    {
      name: 'feedback.query',
      params: [
        { name: 'sentiment', type: 'string', values: ['positive', 'negative'] },
        { name: 'createdFrom', type: 'date' },
        { name: 'isPinned', type: 'boolean' },
      ],
      columns: [{ name: 'account', type: 'string', nullable: true }],
    },
  ],
};
const CONTEXT: StepLintContext = { sqlSourceName: 'db', apiSchemas: { notion: NOTION }, input: { plan: 'Enterprise', since: null }, maxSteps: 4 };
const SQL_STEP: SqlStep = { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts WHERE plan = $1::text', params: ['plan'] };
const API_STEP: ApiStep = {
  name: 'feedback',
  source: 'notion',
  operation: 'feedback.query',
  args: [
    { param: 'sentiment', input: null, value: 'negative' },
    { param: 'createdFrom', input: 'since', value: null },
  ],
};
const VALID: Artifact = { version: 2, unsatisfiable: null, steps: [SQL_STEP, API_STEP], shapeJs: 'function shape(data) { return data.accounts; }', assumptions: [] };

function withSteps(steps: Artifact['steps'], overrides: Partial<Artifact> = {}): Artifact {
  return { ...VALID, steps, ...overrides };
}

function withArgs(args: ApiStep['args']): Artifact {
  return withSteps([SQL_STEP, { ...API_STEP, args }]);
}

function refusal(artifact: Artifact, pattern: RegExp, code = 'INVALID_HANDLER'): void {
  assert.throws(() => lintSteps(artifact, CONTEXT), (error: { code?: string; message?: string }) => error.code === code && pattern.test(error.message ?? ''));
}

describe('step lint (design §3.5)', () => {
  test('accepts a valid two-step handler', () => {
    assert.doesNotThrow(() => lintSteps(VALID, CONTEXT));
  });

  test('refuses no steps and more than maxSteps', () => {
    refusal(withSteps([]), /1 to 4 steps; this one has 0/);
    refusal(withSteps([SQL_STEP, { ...API_STEP, name: 'b' }, { ...API_STEP, name: 'c' }, { ...API_STEP, name: 'd' }, { ...API_STEP, name: 'e' }]), /this one has 5/);
  });

  test('refuses bad and duplicate step names', () => {
    refusal(withSteps([{ ...SQL_STEP, name: 'Accounts' }]), /must start with a lowercase letter/);
    refusal(withSteps([SQL_STEP, { ...API_STEP, name: 'accounts' }]), /used twice/);
  });

  test('refuses unknown sources and the wrong kind of source', () => {
    refusal(withSteps([{ ...SQL_STEP, source: 'warehouse' }]), /unknown source "warehouse"/);
    refusal(withSteps([{ ...SQL_STEP, source: 'notion' }]), /is SQL but "notion" is an API source/);
    refusal(withSteps([SQL_STEP, { ...API_STEP, source: 'db' }]), /"db" is the SQL source/);
    refusal(withSteps([SQL_STEP, { ...API_STEP, source: 'jira' }]), /unknown source "jira"/);
  });

  test('refuses an unknown operation or param, and a param bound twice', () => {
    refusal(withSteps([SQL_STEP, { ...API_STEP, operation: 'feedback.delete' }]), /no operation "feedback.delete"/);
    refusal(withArgs([{ param: 'owner', input: null, value: 'x' }]), /has no such param/);
    refusal(withArgs([{ param: 'sentiment', input: null, value: 'negative' }, { param: 'sentiment', input: null, value: 'positive' }]), /binds "sentiment" twice/);
  });

  test('needs exactly one of input and value, and a known input name', () => {
    refusal(withArgs([{ param: 'sentiment', input: 'plan', value: 'negative' }]), /exactly one of input and value/);
    refusal(withArgs([{ param: 'sentiment', input: null, value: null }]), /exactly one of input and value/);
    refusal(withArgs([{ param: 'sentiment', input: 'mood', value: null }]), /"mood" is not an input name/);
  });

  test('checks a constant against the param type and allowed values', () => {
    refusal(withArgs([{ param: 'isPinned', input: null, value: 'yes' }]), /must be a boolean/);
    refusal(withArgs([{ param: 'createdFrom', input: null, value: '21/11/2026' }]), /must be a date/);
    refusal(withArgs([{ param: 'sentiment', input: null, value: 'angry' }]), /one of positive, negative/);
  });

  test('refuses a constant copied from an input value', () => {
    const context = { ...CONTEXT, input: { mood: 'negative', plan: 'Enterprise' } };
    assert.throws(() => lintSteps(withArgs([{ param: 'sentiment', input: null, value: 'negative' }]), context), /input "mood" is hardcoded/);
  });

  test('needs shapeJs with more than one step, and runs the SQL lint on SQL steps', () => {
    refusal(withSteps([SQL_STEP, API_STEP], { shapeJs: null }), /needs shapeJs/);
    refusal(withSteps([{ ...SQL_STEP, sql: 'DELETE FROM accounts WHERE plan = $1::text' }]), /write or a forbidden function/, 'WRITE_REFUSED');
    refusal(withSteps([{ ...SQL_STEP, params: ['region'] }]), /"region", which is not an input name/);
  });
});
