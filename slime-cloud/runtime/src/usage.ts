// Per-endpoint usage counters for the admin's board and bill estimate.
//
// Item in the control table (see docs/slime-cloud/architecture.html):
//   pk USAGE#<tenantId>, sk <YYYY-MM> (UTC), requests N, generations N, updatedAt.
// Counts accumulate in memory during a request and are written with one atomic
// ADD before the response (Lambda freezes the process afterwards). A failed
// write is logged and dropped: usage must never fail a request.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { QueryMeta } from '@slime-cloud/core/engine.js';
import type { DocClient } from './store-dynamodb.js';

export class UsageMeter {
  private readonly client: DocClient;
  private requests = 0;
  private generations = 0;

  constructor(
    private readonly table: string,
    private readonly tenantId: string,
    client?: DocClient,
  ) {
    this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  /** One answered query; a cache miss means the engine generated a handler. */
  record(meta: Pick<QueryMeta, 'cache'>): void {
    this.requests += 1;
    if (meta.cache === 'miss') this.generations += 1;
  }

  async flush(): Promise<void> {
    if (this.requests === 0 && this.generations === 0) return;
    const r = this.requests;
    const g = this.generations;
    this.requests = 0;
    this.generations = 0;
    const now = new Date().toISOString();
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `USAGE#${this.tenantId}`, sk: now.slice(0, 7) },
          UpdateExpression: 'ADD requests :r, generations :g SET updatedAt = :u',
          ExpressionAttributeValues: { ':r': r, ':g': g, ':u': now },
        }),
      );
    } catch (err) {
      console.error(JSON.stringify({ usage: 'flush_failed', message: (err as Error).message }));
    }
  }
}
