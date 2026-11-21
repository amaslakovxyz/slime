// Per-endpoint usage counters for the admin's board and bill estimate.
//
// One item per endpoint per UTC day in the control table (see
// docs/architecture/slime-cloud.html):
//   pk USAGE#<tenantId>, sk <YYYY-MM-DD>
//   ADD requests, generations, <tier>Requests, <tier>Ms, tokens
//   SET updatedAt, gasHandlers, liquidHandlers, crystalHandlers (snapshot of this instance)
// Counts accumulate in memory during a request and are written with one atomic
// update before the response (Lambda freezes the process afterwards). A failed
// write is logged and dropped: usage must never fail a request.
//
// The endpoint role may only write USAGE_ATTRIBUTES (dynamodb:Attributes in
// platform/provisioner/src/provision.ts): a new attribute here needs the
// same name there, or every flush fails with AccessDenied.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { QueryMeta, Tier } from '@slime-cloud/core';

/** The slice of DynamoDBDocumentClient the meter uses; tests pass a fake. */
export interface UsageClient {
  send(command: UpdateCommand): Promise<unknown>;
}

/** Handler counts by tier as this instance sees them (store-loaded Gas/Liquid, bundled Crystal). */
export interface HandlerSnapshot {
  gas: number;
  liquid: number;
  crystal: number;
}

type Counters = {
  requests: number;
  generations: number;
  gasRequests: number;
  liquidRequests: number;
  crystalRequests: number;
  gasMs: number;
  liquidMs: number;
  crystalMs: number;
  tokens: number;
};

const zero = (): Counters => ({
  requests: 0,
  generations: 0,
  gasRequests: 0,
  liquidRequests: 0,
  crystalRequests: 0,
  gasMs: 0,
  liquidMs: 0,
  crystalMs: 0,
  tokens: 0,
});

export class UsageMeter {
  private readonly client: UsageClient;
  private counts = zero();

  constructor(
    private readonly table: string,
    private readonly tenantId: string,
    private readonly snapshot: () => HandlerSnapshot,
    client?: UsageClient,
  ) {
    this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  /** One answered query; a cache miss means the engine generated a handler. */
  record(meta: Pick<QueryMeta, 'cache' | 'tier' | 'timingsMs'>): void {
    const c = this.counts;
    const tier: Tier = meta.tier;
    c.requests += 1;
    c[`${tier}Requests`] += 1;
    c[`${tier}Ms`] += Math.round(meta.timingsMs.total);
    if (meta.cache === 'miss') c.generations += 1;
  }

  /** Model tokens of one generation (the core's `generated` event; input + output). */
  recordTokens(tokens: number): void {
    this.counts.tokens += tokens;
  }

  async flush(): Promise<void> {
    if (this.counts.requests === 0) return;
    const c = this.counts;
    this.counts = zero();
    const now = new Date().toISOString();
    try {
      const { gas, liquid, crystal } = this.snapshot();
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `USAGE#${this.tenantId}`, sk: now.slice(0, 10) },
          UpdateExpression:
            'ADD requests :r, generations :g, gasRequests :gr, liquidRequests :lr, crystalRequests :cr, ' +
            'gasMs :gm, liquidMs :lm, crystalMs :cm, tokens :t ' +
            'SET updatedAt = :u, gasHandlers = :gh, liquidHandlers = :lh, crystalHandlers = :ch',
          ExpressionAttributeValues: {
            ':r': c.requests,
            ':g': c.generations,
            ':gr': c.gasRequests,
            ':lr': c.liquidRequests,
            ':cr': c.crystalRequests,
            ':gm': c.gasMs,
            ':lm': c.liquidMs,
            ':cm': c.crystalMs,
            ':t': c.tokens,
            ':u': now,
            ':gh': gas,
            ':lh': liquid,
            ':ch': crystal,
          },
        }),
      );
    } catch (err) {
      console.error(JSON.stringify({ usage: 'flush_failed', message: (err as Error).message }));
    }
  }
}
