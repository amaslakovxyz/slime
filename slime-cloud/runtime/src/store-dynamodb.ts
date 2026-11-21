// The core's SlimeStore Port on the existing DynamoDB table (C13, M7).
//
// Item: partition key `tenantId` (one partition per tenant, so an IAM
// LeadingKeys condition can fence a tenant), sort key `artifactKey` set to
// `${ns}#${key}`, and the value as a JSON string so nested shapes never meet
// DynamoDB's type rules. Items the sandbox engine wrote have sort keys with
// no '#'; they are never listed here, so a rollback to the old runtime still
// finds them (see legacy-handlers.ts for copying them over).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { SlimeStore, StoreEntry } from '@slime-cloud/core';

/** The slice of DynamoDBDocumentClient the store uses; tests pass a fake. */
export interface DocClient {
  send(command: GetCommand | PutCommand | QueryCommand | DeleteCommand): Promise<any>;
}

export interface DynamoStoreOptions {
  table: string;
  tenantId: string;
  client?: DocClient;
}

const KEY_SEPARATOR = '#';

export class DynamoSlimeStore implements SlimeStore {
  readonly #table: string;
  readonly #tenantId: string;
  readonly #client: DocClient;

  constructor({ table, tenantId, client }: DynamoStoreOptions) {
    if (!table) throw new Error('DynamoSlimeStore needs a table name (SLIME_HANDLERS_TABLE)');
    if (!tenantId) throw new Error('DynamoSlimeStore needs a tenant id (SLIME_TENANT_ID)');
    this.#table = table;
    this.#tenantId = tenantId;
    this.#client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async get(ns: string, key: string): Promise<unknown | undefined> {
    const { Item } = await this.#client.send(new GetCommand({ TableName: this.#table, Key: this.#key(ns, key), ConsistentRead: true }));
    return Item ? JSON.parse(Item.value) : undefined;
  }

  async put(ns: string, key: string, value: unknown): Promise<void> {
    const item = { ...this.#key(ns, key), value: JSON.stringify(value), updatedAt: new Date().toISOString() };
    await this.#client.send(new PutCommand({ TableName: this.#table, Item: item }));
  }

  async list(ns: string, prefix = ''): Promise<StoreEntry[]> {
    const namespacePrefix = `${ns}${KEY_SEPARATOR}`;
    const entries: StoreEntry[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.#client.send(
        new QueryCommand({
          TableName: this.#table,
          KeyConditionExpression: 'tenantId = :tenant AND begins_with(artifactKey, :prefix)',
          ExpressionAttributeValues: { ':tenant': this.#tenantId, ':prefix': `${namespacePrefix}${prefix}` },
          ConsistentRead: true,
          ExclusiveStartKey,
        }),
      );
      for (const item of page.Items ?? []) entries.push({ key: item.artifactKey.slice(namespacePrefix.length), value: JSON.parse(item.value) });
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return entries;
  }

  async delete(ns: string, key: string): Promise<void> {
    await this.#client.send(new DeleteCommand({ TableName: this.#table, Key: this.#key(ns, key) }));
  }

  #key(ns: string, key: string): { tenantId: string; artifactKey: string } {
    return { tenantId: this.#tenantId, artifactKey: `${ns}${KEY_SEPARATOR}${key}` };
  }
}
