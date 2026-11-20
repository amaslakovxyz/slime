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

export async function dispatch(event: StreamEvent, deps: Deps): Promise<void> {
  for (const record of event.Records) {
    const image = record.dynamodb?.NewImage;
    if (!image) continue;
    const ep = unmarshall(image as Record<string, AttributeValue>) as Endpoint;
    if (ep.type !== 'endpoint') continue;
    if (ep.status === 'pending') await provision(ep, deps);
    else if (ep.status === 'deleting') await teardown(ep, deps);
  }
}
