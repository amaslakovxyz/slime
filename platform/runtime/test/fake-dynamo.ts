// Just enough DynamoDB for the store and the migration: one table keyed by
// tenantId + artifactKey, Query with an optional begins_with, and pages of `pageSize`.
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
    const prefix: string = values[':prefix'] ?? '';
    const matching = [...this.items.values()]
      .filter((item) => item.tenantId === values[':tenant'] && String(item.artifactKey).startsWith(prefix))
      .sort((a, b) => String(a.artifactKey).localeCompare(String(b.artifactKey)));
    const start = input.ExclusiveStartKey ? matching.findIndex((item) => item.artifactKey === input.ExclusiveStartKey.artifactKey) + 1 : 0;
    const page = matching.slice(start, start + this.#pageSize);
    const hasMore = start + this.#pageSize < matching.length;
    return { Items: page.map((item) => structuredClone(item)), LastEvaluatedKey: hasMore ? { tenantId: values[':tenant'], artifactKey: page.at(-1)!.artifactKey } : undefined };
  }
}

function itemKey({ tenantId, artifactKey }: Item): string {
  return `${tenantId}|${artifactKey}`;
}
