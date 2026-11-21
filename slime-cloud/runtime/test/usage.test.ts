// UsageMeter against a fake client: per-tier batching per request, the exact
// attribute set the endpoint IAM policy allows, and never failing a request.
import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UpdateCommand, type PutCommand, type QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { QueryMeta } from '@slime-cloud/core/engine.js';
import type { DocClient } from '../src/store-dynamodb.js';
import { UsageMeter } from '../src/usage.js';

class RecordingClient implements DocClient {
  sent: Array<PutCommand | QueryCommand | UpdateCommand> = [];
  async send(cmd: PutCommand | QueryCommand | UpdateCommand): Promise<any> {
    this.sent.push(cmd);
    return {};
  }
}

const timings = (total: number) => ({ generate: 0, check: 0, execute: 0, shape: 0, total });
const generation = (inputTokens: number, outputTokens: number) =>
  ({ ms: 0, waitMs: 0, attempts: 1, inputTokens, outputTokens, cacheReadTokens: 0 }) as QueryMeta['generation'];
const snapshot = () => ({ gas: 3, crystal: 2 });

// Must equal the endpoint role's dynamodb:Attributes list
// (slime-cloud/provisioner/src/provision.ts), minus the keys.
const ALLOWED = [
  'requests', 'generations', 'gasRequests', 'liquidRequests', 'crystalRequests',
  'gasMs', 'liquidMs', 'crystalMs', 'inputTokens', 'outputTokens',
  'gasHandlers', 'crystalHandlers', 'updatedAt',
];

test('flush writes one daily update with per-tier counts, tokens and the handler snapshot', async () => {
  const client = new RecordingClient();
  const meter = new UsageMeter('slime-control', 'ep-a1b2c3d4e5', snapshot, client);
  meter.record({ cache: 'miss', tier: 'gas', timingsMs: timings(310.4), generation: generation(1200, 300) });
  meter.record({ cache: 'hit', tier: 'liquid', timingsMs: timings(4.6) });
  meter.record({ cache: 'hit', tier: 'liquid', timingsMs: timings(3.2) });
  meter.record({ cache: 'coalesced', tier: 'crystal', timingsMs: timings(0.4) });
  await meter.flush();

  assert.equal(client.sent.length, 1);
  const cmd = client.sent[0];
  assert.ok(cmd instanceof UpdateCommand);
  const input = cmd.input;
  assert.equal(input.TableName, 'slime-control');
  assert.deepEqual(input.Key, { pk: 'USAGE#ep-a1b2c3d4e5', sk: new Date().toISOString().slice(0, 10) });
  const names = [...input.UpdateExpression!.matchAll(/(\w+) (?:=|:)/g)].map((m) => m[1]);
  assert.deepEqual(names.sort(), [...ALLOWED].sort());
  const v = input.ExpressionAttributeValues!;
  assert.deepEqual(
    [v[':r'], v[':g'], v[':gr'], v[':lr'], v[':cr'], v[':gm'], v[':lm'], v[':cm'], v[':it'], v[':ot'], v[':gh'], v[':ch']],
    [4, 1, 1, 2, 1, 310, 8, 0, 1200, 300, 3, 2],
  );

  await meter.flush();
  assert.equal(client.sent.length, 1);
});

test('a failing write is logged, not thrown', async () => {
  const failing: DocClient = {
    send: async () => {
      throw new Error('throttled');
    },
  };
  const meter = new UsageMeter('slime-control', 'ep-x', snapshot, failing);
  meter.record({ cache: 'hit', tier: 'liquid', timingsMs: timings(2) });
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  try {
    await meter.flush();
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, [JSON.stringify({ usage: 'flush_failed', message: 'throttled' })]);
});
