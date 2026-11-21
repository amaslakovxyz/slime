// UsageMeter against a fake client: per-tier batching per request, the exact
// attribute set the runtime IAM policy allows, and never failing a request.
import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { USAGE_ATTRIBUTES, UsageMeter, type UsageClient } from '../src/usage.js';

class RecordingClient implements UsageClient {
  sent: UpdateCommand[] = [];
  async send(cmd: UpdateCommand): Promise<unknown> {
    this.sent.push(cmd);
    return {};
  }
}

const timings = (total: number) => ({ run: 0, shape: 0, total });
const snapshot = () => ({ gas: 3, liquid: 5, crystal: 2 });

// The runtime role's dynamodb:Attributes list (platform/infra/platform/runtime.tf)
// mirrors USAGE_ATTRIBUTES; the flush must write exactly those, minus the keys.
const ALLOWED: string[] = USAGE_ATTRIBUTES.filter((name) => name !== 'pk' && name !== 'sk');

test('flush writes one daily update with per-tier counts, tokens and the handler snapshot', async () => {
  const client = new RecordingClient();
  const meter = new UsageMeter('slime-control', 'ep-a1b2c3d4e5', snapshot, client);
  meter.record({ cache: 'miss', tier: 'gas', timingsMs: timings(310.4) });
  meter.recordTokens(1500);
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
    [v[':r'], v[':g'], v[':gr'], v[':lr'], v[':cr'], v[':gm'], v[':lm'], v[':cm'], v[':t'], v[':gh'], v[':lh'], v[':ch']],
    [4, 1, 1, 2, 1, 310, 8, 0, 1500, 3, 5, 2],
  );

  await meter.flush();
  assert.equal(client.sent.length, 1);
});

test('a failing write is logged, not thrown', async () => {
  const failing: UsageClient = {
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
