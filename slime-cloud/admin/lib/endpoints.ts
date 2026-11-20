// Endpoint records in slime-control. The admin only writes `pending` and
// `deleting`; slime-provisioner (DynamoDB stream) does the AWS work and moves
// the item through provisioning -> ready|failed, or removes it.
import { randomBytes } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb';
import { env } from './env';
import { CodedError } from './errors';
import { estimateBill } from './pricing';
import { secretStore } from './secrets';

export const PROVIDERS = ['claude', 'groq', 'offline'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const STATUSES = ['pending', 'provisioning', 'ready', 'failed', 'deleting'] as const;
export type Status = (typeof STATUSES)[number];

export interface Endpoint {
  endpointId: string;
  owner: string;
  name: string;
  provider: Provider;
  status: Status;
  tokenHint: string;
  url?: string;
  layerArn?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EndpointStats {
  requests: number;
  generations: number;
  liquidHandlers: number;
}

export interface Overview {
  total: number;
  byStatus: Record<Status, number>;
  requests: number;
  generations: number;
  liquidHandlers: number;
  estimatedUsd: number;
}

export const isProvider = (value: string): value is Provider => (PROVIDERS as readonly string[]).includes(value);

const ownerKey = (owner: string) => `USER#${owner}`;
const endpointKey = (owner: string, endpointId: string) => ({ pk: ownerKey(owner), sk: `ENDPOINT#${endpointId}` });
/** Usage items are per UTC calendar month. */
export const currentMonth = () => new Date().toISOString().slice(0, 7);

export async function createEndpoint(
  owner: string,
  input: { name: string; provider: string; databaseUrl: string },
): Promise<string> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 40) throw new CodedError('INVALID', 'Name must be 1-40 characters');
  if (!isProvider(input.provider)) throw new CodedError('INVALID', `Provider must be one of ${PROVIDERS.join(', ')}`);
  const databaseUrl = input.databaseUrl.trim();
  if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
    throw new CodedError('INVALID', 'Postgres URL must start with postgres:// or postgresql://');
  }

  const endpointId = 'ep-' + randomBytes(5).toString('hex');
  const token = 'slm_' + randomBytes(24).toString('base64url');
  const secrets = secretStore();
  // Secrets first: the provisioner starts as soon as the item appears and reads them.
  await secrets.put(endpointId, 'DATABASE_URL', databaseUrl);
  await secrets.put(endpointId, 'SLIME_API_KEY', token);

  const now = new Date().toISOString();
  const item: Endpoint & { pk: string; sk: string; type: 'endpoint' } = {
    ...endpointKey(owner, endpointId),
    type: 'endpoint',
    endpointId,
    owner,
    name,
    provider: input.provider,
    status: 'pending',
    tokenHint: token.slice(-4),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await ddb().send(new PutCommand({ TableName: env().controlTable, Item: item }));
  } catch (err) {
    await secrets.removeAll(endpointId);
    throw err;
  }
  return endpointId;
}

const toEndpoint = (item: Record<string, any>): Endpoint => {
  const { pk: _pk, sk: _sk, type: _type, ...endpoint } = item;
  return endpoint as Endpoint;
};

export async function listEndpoints(owner: string): Promise<Endpoint[]> {
  const endpoints: Endpoint[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const page = await ddb().send(
      new QueryCommand({
        TableName: env().controlTable,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': ownerKey(owner), ':prefix': 'ENDPOINT#' },
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) endpoints.push(toEndpoint(item));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return endpoints;
}

/** Keyed by owner, so a user can never read another user's endpoint. */
export async function getEndpoint(owner: string, endpointId: string): Promise<Endpoint | undefined> {
  const out = await ddb().send(new GetCommand({ TableName: env().controlTable, Key: endpointKey(owner, endpointId) }));
  return out.Item ? toEndpoint(out.Item) : undefined;
}

export async function requestDelete(owner: string, endpointId: string): Promise<void> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: env().controlTable,
        Key: endpointKey(owner, endpointId),
        UpdateExpression: 'SET #s = :deleting, updatedAt = :now',
        ConditionExpression: '#s IN (:ready, :failed)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':deleting': 'deleting',
          ':ready': 'ready',
          ':failed': 'failed',
          ':now': new Date().toISOString(),
        },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new CodedError('NOT_DELETABLE', 'Only ready or failed endpoints can be deleted');
    }
    throw err;
  }
}

export async function revealToken(owner: string, endpointId: string): Promise<string | undefined> {
  if (!(await getEndpoint(owner, endpointId))) return undefined;
  return secretStore().get(endpointId, 'SLIME_API_KEY');
}

export async function endpointStats(endpointId: string): Promise<EndpointStats> {
  const { controlTable, handlersTable } = env();
  const countHandlers = async () => {
    let count = 0;
    let ExclusiveStartKey: Record<string, any> | undefined;
    do {
      const page = await ddb().send(
        new QueryCommand({
          TableName: handlersTable,
          KeyConditionExpression: 'tenantId = :id',
          ExpressionAttributeValues: { ':id': endpointId },
          Select: 'COUNT',
          ExclusiveStartKey,
        }),
      );
      count += page.Count ?? 0;
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return count;
  };
  const [usage, liquidHandlers] = await Promise.all([
    ddb().send(new GetCommand({ TableName: controlTable, Key: { pk: `USAGE#${endpointId}`, sk: currentMonth() } })),
    countHandlers(),
  ]);
  return {
    requests: Number(usage.Item?.requests ?? 0),
    generations: Number(usage.Item?.generations ?? 0),
    liquidHandlers,
  };
}

export type EndpointWithStats = Endpoint & { stats: EndpointStats };

export async function listWithStats(owner: string): Promise<EndpointWithStats[]> {
  const endpoints = await listEndpoints(owner);
  return Promise.all(endpoints.map(async (ep) => ({ ...ep, stats: await endpointStats(ep.endpointId) })));
}

export function summarize(rows: EndpointWithStats[]): Overview {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  let requests = 0;
  let generations = 0;
  let liquidHandlers = 0;
  for (const row of rows) {
    if (row.status in byStatus) byStatus[row.status] += 1;
    requests += row.stats.requests;
    generations += row.stats.generations;
    liquidHandlers += row.stats.liquidHandlers;
  }
  return {
    total: rows.length,
    byStatus,
    requests,
    generations,
    liquidHandlers,
    estimatedUsd: estimateBill({ requests, generations }),
  };
}

export async function overview(owner: string): Promise<Overview> {
  return summarize(await listWithStats(owner));
}
