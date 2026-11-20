// Lambda entry for slime-provisioner: the slime-control stream, filtered by the
// event source mapping to endpoint items in status pending or deleting
// (infra/aws/platform/provisioner.tf). The worker's own writes (provisioning,
// ready, failed) never match that filter, so it cannot trigger itself.
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { defaultDeps, type Deps, type Endpoint } from './deps.js';
import { provision } from './provision.js';
import { teardown } from './teardown.js';

export interface StreamEvent {
  Records: Array<{ eventName: string; dynamodb?: { NewImage?: Record<string, any> } }>;
}

let deps: Deps | undefined;

// Lambda passes (event, context): deps cannot be a second parameter here.
export async function handler(event: StreamEvent): Promise<void> {
  await dispatch(event, (deps ??= defaultDeps()));
}

/**
 * Only genuine endpoint items count: the key must be the one the admin writes
 * (USER#<owner> / ENDPOINT#<endpointId>). Endpoint roles may UpdateItem their own
 * USAGE#<id> partition; without this check such a role could write an item
 * that looks like another tenant's endpoint in `deleting` and make this worker
 * tear that endpoint down.
 */
export function isEndpointItem(item: Record<string, unknown>): boolean {
  return (
    item.type === 'endpoint' &&
    typeof item.owner === 'string' &&
    typeof item.endpointId === 'string' &&
    /^ep-[0-9a-f]{10}$/.test(item.endpointId) &&
    item.pk === `USER#${item.owner}` &&
    item.sk === `ENDPOINT#${item.endpointId}`
  );
}

export async function dispatch(event: StreamEvent, deps: Deps): Promise<void> {
  for (const record of event.Records) {
    const image = record.dynamodb?.NewImage;
    if (!image) continue;
    const item = unmarshall(image as Record<string, AttributeValue>);
    if (!isEndpointItem(item)) {
      console.warn(JSON.stringify({ skipped: 'not_an_endpoint_item', pk: String(item.pk).slice(0, 80) }));
      continue;
    }
    const ep = item as Endpoint;
    if (ep.status === 'pending') await provision(ep, deps);
    else if (ep.status === 'deleting') await teardown(ep, deps);
  }
}
