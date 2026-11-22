// Just enough DynamoDB for the store and the migration: one table keyed by
// tenantId + artifactKey, Query with begins_with or BETWEEN, either order, Limit, and pages of `pageSize`.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DocClient } from '../src/store-dynamodb.js';

type Item = Record<string, any>;

export class FakeDynamo implements DocClient {
  readonly items = new Map<string, Item>();
  readonly #pageSize: number;

  constructor(pageSize = 100) {
    this.#pageSize = pageSize;
  }

  async send(command: GetCommand | PutCommand | QueryCommand | DeleteCommand): Promise<any> {
    const input = command.input as Item;
    if (command instanceof PutCommand) {
      this.items.set(itemKey(input.Item), structuredClone(input.Item));
      return {};
    }
    if (command instanceof GetCommand) {
      const item = this.items.get(itemKey(input.Key));
      return { Item: item ? structuredClone(item) : undefined };
    }
    if (command instanceof DeleteCommand) {
      this.items.delete(itemKey(input.Key));
      return {};
    }
    return this.#query(input);
  }

  #query(input: Item): Item {
    const values = input.ExpressionAttributeValues;
    const inRange = String(input.KeyConditionExpression ?? '').includes('BETWEEN')
      ? (key: string) => key >= values[':lo'] && key <= values[':hi']
      : (key: string) => key.startsWith(values[':prefix'] ?? '');
    const matching = [...this.items.values()]
      .filter((item) => item.tenantId === values[':tenant'] && inRange(String(item.artifactKey)))
      .sort((a, b) => (String(a.artifactKey) < String(b.artifactKey) ? -1 : String(a.artifactKey) > String(b.artifactKey) ? 1 : 0)); // byte order, as DynamoDB
    if (input.ScanIndexForward === false) matching.reverse();
    const start = input.ExclusiveStartKey ? matching.findIndex((item) => item.artifactKey === input.ExclusiveStartKey.artifactKey) + 1 : 0;
    const size = Math.min(this.#pageSize, input.Limit ?? Infinity);
    const page = matching.slice(start, start + size);
    const hasMore = start + size < matching.length;
    return { Items: page.map((item) => structuredClone(item)), LastEvaluatedKey: hasMore ? { tenantId: values[':tenant'], artifactKey: page.at(-1)!.artifactKey } : undefined };
  }
}

function itemKey({ tenantId, artifactKey }: Item): string {
  return `${tenantId}|${artifactKey}`;
}
