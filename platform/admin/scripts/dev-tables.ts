// Creates the control and handlers tables in DynamoDB Local. Refuses to run
// without AWS_ENDPOINT_URL_DYNAMODB so it can never touch real AWS.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

async function exists(client: DynamoDBClient, TableName: string): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName }));
    return true;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return false;
    throw err;
  }
}

/** Creates any missing table; returns the names it created. */
export async function createDevTables(
  client: DynamoDBClient,
  tables: { control: string; handlers: string },
): Promise<string[]> {
  const created: string[] = [];
  if (!(await exists(client, tables.control))) {
    await client.send(
      new CreateTableCommand({
        TableName: tables.control,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' },
      }),
    );
    created.push(tables.control);
  }
  if (!(await exists(client, tables.handlers))) {
    await client.send(
      new CreateTableCommand({
        TableName: tables.handlers,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'tenantId', AttributeType: 'S' },
          { AttributeName: 'artifactKey', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'tenantId', KeyType: 'HASH' },
          { AttributeName: 'artifactKey', KeyType: 'RANGE' },
        ],
      }),
    );
    created.push(tables.handlers);
  }
  return created;
}

async function main() {
  // Same settings `next dev` uses; values already in the environment win.
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  if (!process.env.AWS_ENDPOINT_URL_DYNAMODB) {
    console.error('AWS_ENDPOINT_URL_DYNAMODB is not set; refusing to create tables outside DynamoDB Local.');
    process.exit(1);
  }
  const client = new DynamoDBClient({});
  // DynamoDB Local can take a moment after `infra:up` before it accepts requests.
  for (let attempt = 1; ; attempt++) {
    try {
      await client.send(new ListTablesCommand({}));
      break;
    } catch (err) {
      if (attempt >= 20) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const tables = {
    control: process.env.SLIME_CONTROL_TABLE || 'slime-control',
    handlers: process.env.SLIME_HANDLERS_TABLE || 'slime-handlers',
  };
  const created = await createDevTables(client, tables);
  console.log(created.length ? `Created ${created.join(', ')}` : `Tables exist: ${tables.control}, ${tables.handlers}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
