// UsageMeter against a fake client: batching per request, and never failing one.
import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UpdateCommand, type PutCommand, type QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DocClient } from '../src/store-dynamodb.js';
import { UsageMeter } from '../src/usage.js';

class RecordingClient implements DocClient {
  sent: Array<PutCommand | QueryCommand | UpdateCommand> = [];
  async send(cmd: PutCommand | QueryCommand | UpdateCommand): Promise<any> {
    this.sent.push(cmd);
    return {};
  }
}

test('flush writes one atomic ADD per request batch, and nothing when idle', async () => {
  const client = new RecordingClient();
  const meter = new UsageMeter('slime-control', 'ep-a1b2c3d4e5', client);
  meter.record({ cache: 'miss' });
  meter.record({ cache: 'hit' });
  await meter.flush();

  assert.equal(client.sent.length, 1);
  const cmd = client.sent[0];
  assert.ok(cmd instanceof UpdateCommand);
  const input = cmd.input;
  assert.equal(input.TableName, 'slime-control');
  assert.deepEqual(input.Key, { pk: 'USAGE#ep-a1b2c3d4e5', sk: new Date().toISOString().slice(0, 7) });
  assert.equal(input.UpdateExpression, 'ADD requests :r, generations :g SET updatedAt = :u');
  assert.equal(input.ExpressionAttributeValues?.[':r'], 2);
  assert.equal(input.ExpressionAttributeValues?.[':g'], 1);

  await meter.flush();
  assert.equal(client.sent.length, 1);
});

test('a failing write is logged, not thrown', async () => {
  const failing: DocClient = {
    send: async () => {
      throw new Error('throttled');
    },
  };
  const meter = new UsageMeter('slime-control', 'ep-x', failing);
  meter.record({ cache: 'coalesced' });
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
