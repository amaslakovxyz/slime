// Per-endpoint usage counters for the admin's board and bill estimate.
//
// One item per endpoint per UTC day in the control table (see
// docs/slime-cloud/architecture.html):
//   pk USAGE#<tenantId>, sk <YYYY-MM-DD>
//   ADD requests, generations, <tier>Requests, <tier>Ms, inputTokens, outputTokens
//   SET updatedAt, gasHandlers, crystalHandlers (snapshot of this instance)
// Counts accumulate in memory during a request and are written with one atomic
// update before the response (Lambda freezes the process afterwards). A failed
// write is logged and dropped: usage must never fail a request.
//
// The endpoint role may only write USAGE_ATTRIBUTES (dynamodb:Attributes in
// slime-cloud/provisioner/src/provision.ts): a new attribute here needs the
// same name there, or every flush fails with AccessDenied.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { QueryMeta, Tier } from '@slime-cloud/core/engine.js';
import type { DocClient } from './store-dynamodb.js';

/** Handler counts this instance holds outside the Liquid table. */
export interface HandlerSnapshot {
  gas: number;
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
  inputTokens: number;
  outputTokens: number;
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
  inputTokens: 0,
  outputTokens: 0,
});

export class UsageMeter {
  private readonly client: DocClient;
  private counts = zero();

  constructor(
    private readonly table: string,
    private readonly tenantId: string,
    private readonly snapshot: () => HandlerSnapshot,
    client?: DocClient,
  ) {
    this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  /** One answered query; a cache miss means the engine generated a handler. */
  record(meta: Pick<QueryMeta, 'cache' | 'tier' | 'timingsMs' | 'generation'>): void {
    const c = this.counts;
    const tier: Tier = meta.tier;
    c.requests += 1;
    c[`${tier}Requests`] += 1;
    c[`${tier}Ms`] += Math.round(meta.timingsMs.total);
    if (meta.cache === 'miss') c.generations += 1;
    if (meta.generation) {
      c.inputTokens += meta.generation.inputTokens;
      c.outputTokens += meta.generation.outputTokens;
    }
  }

  async flush(): Promise<void> {
    if (this.counts.requests === 0) return;
    const c = this.counts;
    this.counts = zero();
    const now = new Date().toISOString();
    try {
      const { gas, crystal } = this.snapshot();
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `USAGE#${this.tenantId}`, sk: now.slice(0, 10) },
          UpdateExpression:
            'ADD requests :r, generations :g, gasRequests :gr, liquidRequests :lr, crystalRequests :cr, ' +
            'gasMs :gm, liquidMs :lm, crystalMs :cm, inputTokens :it, outputTokens :ot ' +
            'SET updatedAt = :u, gasHandlers = :gh, crystalHandlers = :ch',
          ExpressionAttributeValues: {
            ':r': c.requests,
            ':g': c.generations,
            ':gr': c.gasRequests,
            ':lr': c.liquidRequests,
            ':cr': c.crystalRequests,
            ':gm': c.gasMs,
            ':lm': c.liquidMs,
            ':cm': c.crystalMs,
            ':it': c.inputTokens,
            ':ot': c.outputTokens,
            ':u': now,
            ':gh': gas,
            ':ch': crystal,
          },
        }),
      );
    } catch (err) {
      console.error(JSON.stringify({ usage: 'flush_failed', message: (err as Error).message }));
    }
  }
}
