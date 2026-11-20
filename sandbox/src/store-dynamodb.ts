// Liquid handler store on DynamoDB, used by the Lambda runtime (Slime Cloud D6).
//
// Item: partition key `tenantId`, sort key `artifactKey`. The scope fields
// (schemaHash, promptHash, model) are plain attributes that loadLiquid filters
// on; one tenant holds few handlers, so a filtered Query is fine. The handler
// body is a JSON string so its nested shapes never meet DynamoDB's type rules;
// fixtures/runs/lastUsedAt sit outside it because updateRuns rewrites only them.
// Integrity stays with the engine, which re-checks codeHash on load.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Fixture, HandlerStore, StoredHandler, StoreScope } from './store.js';

/** The slice of DynamoDBDocumentClient this store uses; tests pass a fake. */
export interface DocClient {
  send(command: PutCommand | QueryCommand | UpdateCommand): Promise<any>;
}

type Body = Omit<StoredHandler, 'fixtures' | 'runs' | 'lastUsedAt'>;

export class DynamoHandlerStore implements HandlerStore {
  readonly kind = 'dynamodb';
  private readonly client: DocClient;

  constructor(
    private readonly table: string,
    private readonly tenantId: string,
    client?: DocClient,
  ) {
    if (!table) throw new Error('DynamoHandlerStore needs a table name');
    if (!tenantId) throw new Error('DynamoHandlerStore needs a tenant id');
    this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  // The table is created by Terraform (infra/aws/platform), not at runtime.
  async init() {}

  async loadLiquid(scope: StoreScope): Promise<StoredHandler[]> {
    const out: StoredHandler[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'tenantId = :t',
          FilterExpression: 'schemaHash = :s AND promptHash = :p AND #model = :m',
          ExpressionAttributeNames: { '#model': 'model' },
          ExpressionAttributeValues: { ':t': this.tenantId, ':s': scope.schemaHash, ':p': scope.promptHash, ':m': scope.model },
          ConsistentRead: true,
          ExclusiveStartKey,
        }),
      );
      for (const item of res.Items ?? []) {
        const body = JSON.parse(item.handler) as Body;
        out.push({ ...body, fixtures: JSON.parse(item.fixtures), runs: Number(item.runs), lastUsedAt: item.lastUsedAt });
      }
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  async saveLiquid(h: StoredHandler) {
    const { fixtures, runs, lastUsedAt, ...body } = h;
    await this.client.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          tenantId: this.tenantId,
          artifactKey: h.artifactKey,
          schemaHash: h.schemaHash,
          promptHash: h.promptHash,
          model: h.model,
          handler: JSON.stringify(body),
          fixtures: JSON.stringify(fixtures),
          runs,
          lastUsedAt,
        },
      }),
    );
  }

  async updateRuns(artifactKey: string, fixtures: Fixture[], runs: number, lastUsedAt: string) {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { tenantId: this.tenantId, artifactKey },
          UpdateExpression: 'SET fixtures = :f, runs = :r, lastUsedAt = :l',
          // Like the Postgres UPDATE: a handler that is not stored stays not stored.
          ConditionExpression: 'attribute_exists(artifactKey)',
          ExpressionAttributeValues: { ':f': JSON.stringify(fixtures), ':r': runs, ':l': lastUsedAt },
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
  }

  async close() {}
}
