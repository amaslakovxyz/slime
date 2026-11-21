// What the local runner removes when an endpoint is deleted, besides the
// control item and secrets: its Liquid handlers (slime-handlers, one partition
// per endpoint) and its data folder (Crystal modules). Mirrors
// slime-provisioner's teardown on AWS; usage items (USAGE#<id>) stay there too.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb';

/** Ids come from createEndpoint ('ep-' + hex); anything else is refused before an rm -r. */
const ENDPOINT_ID = /^ep-[0-9a-f]+$/;
/** BatchWriteItem takes at most 25 requests. */
const BATCH_WRITE_MAX = 25;
const UNPROCESSED_ATTEMPTS = 5;

export async function removeLocalEndpointData(opts: { endpointId: string; handlersTable: string; dataDir: string }): Promise<void> {
  const { endpointId, handlersTable, dataDir } = opts;
  if (!ENDPOINT_ID.test(endpointId)) throw new Error(`Not an endpoint id: ${JSON.stringify(endpointId)}`);

  // Collect every key first: deleting while paging would shift the pages.
  const keys: Array<Record<string, unknown>> = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb().send(
      new QueryCommand({
        TableName: handlersTable,
        KeyConditionExpression: 'tenantId = :t',
        ExpressionAttributeValues: { ':t': endpointId },
        ProjectionExpression: 'tenantId, artifactKey',
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) keys.push({ tenantId: item.tenantId, artifactKey: item.artifactKey });
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  for (let i = 0; i < keys.length; i += BATCH_WRITE_MAX) {
    let requests = keys.slice(i, i + BATCH_WRITE_MAX).map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 1; requests.length; attempt++) {
      if (attempt > UNPROCESSED_ATTEMPTS) throw new Error('Liquid handlers stayed unprocessed');
      const out = await ddb().send(new BatchWriteCommand({ RequestItems: { [handlersTable]: requests } }));
      requests = (out.UnprocessedItems?.[handlersTable] ?? []) as typeof requests;
    }
  }

  await rm(join(dataDir, endpointId), { recursive: true, force: true });
}
