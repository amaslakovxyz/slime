// Removes an endpoint, in both modes: the local runner calls it for a `deleting`
// item, the cloud delete action calls it in the request. Order matters, and differs:
//   local (Crystal folder): handlers, folder, control item, secrets. Secrets go last:
//     the runner treats an endpoint whose secrets it holds as its own, so a failed
//     step leaves it something to retry.
//   cloud (S3): secrets, handlers, every Crystal object version, control item. Secrets
//     go first: the shared runtime serves an id exactly as long as its SSM path exists,
//     so this revokes the keys and the customer's DATABASE_URL on every instance within
//     one TTL even if a later step fails; the item, still there, lets Delete run again.
// Every step is idempotent. Usage items (USAGE#<id>) stay as billing history.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type DeleteObjectsCommandOutput,
  type ListObjectVersionsCommandOutput,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { BatchWriteCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb';
import { endpointKey } from './endpoints';
import { env } from './env';
import type { SecretStore } from './secrets';

/** Ids come from createEndpoint ('ep-' + 10 hex); anything else is refused before an rm -r or a prefix delete. */
const ENDPOINT_ID = /^ep-[0-9a-f]{10}$/;
/** BatchWriteItem takes at most 25 requests. */
const BATCH_WRITE_MAX = 25;
const UNPROCESSED_ATTEMPTS = 5;
/** DeleteObjects takes at most 1000 keys. */
const DELETE_OBJECTS_MAX = 1000;

/** The two S3 calls teardown makes; an S3Client fits, and tests pass a fake. */
export interface CrystalObjects {
  send(command: ListObjectVersionsCommand): Promise<ListObjectVersionsCommandOutput>;
  send(command: DeleteObjectsCommand): Promise<DeleteObjectsCommandOutput>;
}

export type CrystalStorage = { kind: 'dir'; dataDir: string } | { kind: 's3'; bucket: string; client: CrystalObjects };

export interface Teardown {
  endpointId: string;
  owner: string;
  handlersTable: string;
  crystals: CrystalStorage;
  secrets: SecretStore;
}

export async function removeEndpoint({ endpointId, owner, handlersTable, crystals, secrets }: Teardown): Promise<void> {
  if (!ENDPOINT_ID.test(endpointId)) throw new Error(`Not an endpoint id: ${JSON.stringify(endpointId)}`);
  if (crystals.kind === 's3') await secrets.removeAll(endpointId);
  await removeHandlers(endpointId, handlersTable);
  if (crystals.kind === 'dir') await rm(join(crystals.dataDir, endpointId), { recursive: true, force: true });
  else await removeCrystalObjects(crystals.client, crystals.bucket, `endpoints/${endpointId}/`);
  await ddb().send(new DeleteCommand({ TableName: env().controlTable, Key: endpointKey(owner, endpointId) }));
  if (crystals.kind === 'dir') await secrets.removeAll(endpointId);
}

async function removeHandlers(endpointId: string, handlersTable: string): Promise<void> {
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
}

/** Every version and delete marker under the prefix: a plain delete would only hide objects behind a marker. */
async function removeCrystalObjects(client: CrystalObjects, bucket: string, prefix: string): Promise<void> {
  const objects: ObjectIdentifier[] = [];
  let KeyMarker: string | undefined;
  let VersionIdMarker: string | undefined;
  do {
    const page = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker, VersionIdMarker }));
    for (const v of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
      if (v.Key) objects.push({ Key: v.Key, VersionId: v.VersionId });
    }
    [KeyMarker, VersionIdMarker] = page.IsTruncated ? [page.NextKeyMarker, page.NextVersionIdMarker] : [undefined, undefined];
  } while (KeyMarker);

  for (let i = 0; i < objects.length; i += DELETE_OBJECTS_MAX) {
    const out = await client.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.slice(i, i + DELETE_OBJECTS_MAX), Quiet: true } }),
    );
    const failed = out.Errors ?? [];
    if (failed.length) throw new Error(`Could not delete ${failed.length} Crystal object(s): ${failed[0]?.Code ?? 'unknown error'}`);
  }
}
