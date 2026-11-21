// Endpoint records in slime-control. The admin only writes `pending`,
// `updating` and `deleting`; slime-provisioner (DynamoDB stream) does the AWS
// work and moves the item through provisioning -> ready|failed, or removes it.
import { randomBytes } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CONNECTOR_SPECS, validateConnectionUrl, type ConnectorType } from './connectors';
import { ddb } from './ddb';
import { env } from './env';
import { CodedError } from './errors';
import { crystallizationSavings, estimateBill, TIERS, type Tier } from './pricing';
import { secretStore } from './secrets';

export const PROVIDERS = ['claude', 'groq', 'offline'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const STATUSES = ['pending', 'provisioning', 'ready', 'failed', 'updating', 'deleting'] as const;
export type Status = (typeof STATUSES)[number];
/** States the provisioner is working on; the UI polls while in one. */
export const TRANSIENT_STATUSES: readonly Status[] = ['pending', 'provisioning', 'updating', 'deleting'];

export interface Endpoint {
  endpointId: string;
  owner: string;
  name: string;
  provider: Provider;
  connectorType: ConnectorType;
  status: Status;
  tokenHint: string;
  url?: string;
  layerArn?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TierUsage {
  requests: number;
  /** Sum of per-request total ms. */
  ms: number;
  /** null when the tier served no requests. */
  avgMs: number | null;
}

export interface DayUsage {
  /** YYYY-MM-DD (UTC). */
  day: string;
  gas: number;
  liquid: number;
  crystal: number;
}

/** One month of usage for one endpoint, or summed over several. */
export interface Usage {
  month: string;
  requests: number;
  generations: number;
  inputTokens: number;
  outputTokens: number;
  tiers: Record<Tier, TierUsage>;
  /** Every day of the month up to today, zero-filled. */
  daily: DayUsage[];
  /** Warm handler snapshots from the instance that flushed last; null when never reported. */
  gasHandlers: number | null;
  crystalHandlers: number | null;
  /** Stored handlers in slime-handlers. */
  liquidHandlers: number;
  estimatedUsd: number;
  savingsUsd: number;
}

export interface Overview extends Usage {
  total: number;
  byStatus: Record<Status, number>;
}

export const isProvider = (value: string): value is Provider => (PROVIDERS as readonly string[]).includes(value);

const ownerKey = (owner: string) => `USER#${owner}`;
const endpointKey = (owner: string, endpointId: string) => ({ pk: ownerKey(owner), sk: `ENDPOINT#${endpointId}` });
/** Usage is bucketed per UTC day; a month is the days whose key starts with YYYY-MM. */
export const currentMonth = () => new Date().toISOString().slice(0, 7);

function validateName(raw: string): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > 40) throw new CodedError('INVALID', 'Name must be 1-40 characters');
  return name;
}

function validateProvider(provider: string): Provider {
  if (!isProvider(provider)) throw new CodedError('INVALID', `Provider must be one of ${PROVIDERS.join(', ')}`);
  return provider;
}

export async function createEndpoint(
  owner: string,
  input: { name: string; provider: string; databaseUrl: string; connectorType?: string },
): Promise<string> {
  const name = validateName(input.name);
  const provider = validateProvider(input.provider);
  const connectorType = (input.connectorType ?? 'postgres') as ConnectorType;
  const databaseUrl = validateConnectionUrl(connectorType, input.databaseUrl);

  const endpointId = 'ep-' + randomBytes(5).toString('hex');
  const token = 'slm_' + randomBytes(24).toString('base64url');
  const secrets = secretStore();
  // Secrets first: the provisioner starts as soon as the item appears and reads them.
  await secrets.put(endpointId, CONNECTOR_SPECS[connectorType].secret, databaseUrl);
  await secrets.put(endpointId, 'SLIME_API_KEY', token);

  const now = new Date().toISOString();
  const item: Endpoint & { pk: string; sk: string; type: 'endpoint' } = {
    ...endpointKey(owner, endpointId),
    type: 'endpoint',
    endpointId,
    owner,
    name,
    provider,
    connectorType,
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
  // Items written before connectors existed are Postgres.
  return { connectorType: 'postgres', ...endpoint } as Endpoint;
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

async function requireEndpoint(owner: string, endpointId: string): Promise<Endpoint> {
  const ep = await getEndpoint(owner, endpointId);
  if (!ep) throw new CodedError('NOT_FOUND', 'Endpoint not found');
  return ep;
}

const notUpdatable = (message: string) => new CodedError('NOT_UPDATABLE', message);

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

/**
 * Replaces the connection secret. A pending endpoint has not read it yet, so the
 * secret is all that changes; a ready|failed one goes to `updating` and the
 * provisioner redeploys it so fresh instances load the new secret.
 */
export async function updateConnector(
  owner: string,
  endpointId: string,
  input: { connectorType: string; databaseUrl: string },
): Promise<void> {
  const databaseUrl = validateConnectionUrl(input.connectorType, input.databaseUrl);
  const connectorType = input.connectorType as ConnectorType;
  const ep = await requireEndpoint(owner, endpointId);
  const redeploy = ep.status === 'ready' || ep.status === 'failed';
  if (ep.status !== 'pending' && !redeploy) {
    throw notUpdatable(`The connection can change only while pending, ready or failed (now ${ep.status})`);
  }

  const secrets = secretStore();
  const secretName = CONNECTOR_SPECS[connectorType].secret;
  const previous = await secrets.get(endpointId, secretName);
  await secrets.put(endpointId, secretName, databaseUrl, { overwrite: true });
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: env().controlTable,
        Key: endpointKey(owner, endpointId),
        UpdateExpression: redeploy
          ? 'SET #s = :updating, connectorType = :c, updatedAt = :now'
          : 'SET connectorType = :c, updatedAt = :now',
        ConditionExpression: redeploy ? '#s IN (:ready, :failed)' : '#s = :pending',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':c': connectorType,
          ':now': new Date().toISOString(),
          ...(redeploy ? { ':updating': 'updating', ':ready': 'ready', ':failed': 'failed' } : { ':pending': 'pending' }),
        },
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // The status moved under us: the running workflow keeps the secret it started with.
    if (previous !== undefined) await secrets.put(endpointId, secretName, previous, { overwrite: true });
    throw notUpdatable('The endpoint changed state meanwhile; reload and try again');
  }
}

/** Rename works in any state but deleting; a provider change redeploys, so only from ready|failed. */
export async function updateSettings(
  owner: string,
  endpointId: string,
  input: { name: string; provider: string },
): Promise<void> {
  const name = validateName(input.name);
  const provider = validateProvider(input.provider);
  const ep = await requireEndpoint(owner, endpointId);
  if (ep.status === 'deleting') throw notUpdatable('The endpoint is being deleted');
  const providerChanged = provider !== ep.provider;
  if (providerChanged && ep.status !== 'ready' && ep.status !== 'failed') {
    throw notUpdatable(`The provider can change only when ready or failed (now ${ep.status})`);
  }
  if (!providerChanged && name === ep.name) return;

  try {
    await ddb().send(
      new UpdateCommand({
        TableName: env().controlTable,
        Key: endpointKey(owner, endpointId),
        UpdateExpression: providerChanged
          ? 'SET #n = :name, provider = :p, #s = :updating, updatedAt = :now'
          : 'SET #n = :name, updatedAt = :now',
        ConditionExpression: providerChanged ? '#s IN (:ready, :failed)' : 'attribute_exists(pk) AND #s <> :deleting',
        ExpressionAttributeNames: { '#s': 'status', '#n': 'name' },
        ExpressionAttributeValues: {
          ':name': name,
          ':now': new Date().toISOString(),
          ...(providerChanged
            ? { ':p': provider, ':updating': 'updating', ':ready': 'ready', ':failed': 'failed' }
            : { ':deleting': 'deleting' }),
        },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw notUpdatable('The endpoint changed state meanwhile; reload and try again');
    }
    throw err;
  }
}

export async function revealToken(owner: string, endpointId: string): Promise<string | undefined> {
  if (!(await getEndpoint(owner, endpointId))) return undefined;
  return secretStore().get(endpointId, 'SLIME_API_KEY');
}

/** Stored connection URL, for server-side masking and re-testing; never sent to the browser. */
export async function connectionUrl(owner: string, endpointId: string): Promise<string | undefined> {
  const ep = await getEndpoint(owner, endpointId);
  if (!ep) return undefined;
  return secretStore().get(endpointId, CONNECTOR_SPECS[ep.connectorType].secret);
}

/** Days of `month` (YYYY-MM) up to today when it is the current month. */
export function monthDays(month: string): string[] {
  const [year, mon] = month.split('-').map(Number);
  const inMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const today = new Date().toISOString().slice(0, 10);
  const days: string[] = [];
  for (let d = 1; d <= inMonth; d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`;
    if (day > today) break;
    days.push(day);
  }
  return days;
}

const num = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0) || 0);
const avg = (ms: number, requests: number) => (requests > 0 ? ms / requests : null);

/** Fills the derived fields (avgMs, estimate, savings) from summed counters. */
function finish(base: Omit<Usage, 'estimatedUsd' | 'savingsUsd'>): Usage {
  for (const tier of TIERS) base.tiers[tier].avgMs = avg(base.tiers[tier].ms, base.tiers[tier].requests);
  const billable = {
    gasRequests: base.tiers.gas.requests,
    liquidRequests: base.tiers.liquid.requests,
    crystalRequests: base.tiers.crystal.requests,
    generations: base.generations,
  };
  return { ...base, estimatedUsd: estimateBill(billable), savingsUsd: crystallizationSavings(billable) };
}

const emptyTiers = (): Record<Tier, TierUsage> => ({
  gas: { requests: 0, ms: 0, avgMs: null },
  liquid: { requests: 0, ms: 0, avgMs: null },
  crystal: { requests: 0, ms: 0, avgMs: null },
});

/** Sums a month's day items (any order) into Usage. */
export function usageFromItems(month: string, items: Record<string, unknown>[], liquidHandlers: number): Usage {
  const tiers = emptyTiers();
  const byDay = new Map<string, DayUsage>();
  let requests = 0;
  let generations = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let gasHandlers: number | null = null;
  let crystalHandlers: number | null = null;
  let gasSeen = '';
  let crystalSeen = '';
  for (const item of items) {
    const day = String(item.sk);
    requests += num(item.requests);
    generations += num(item.generations);
    inputTokens += num(item.inputTokens);
    outputTokens += num(item.outputTokens);
    for (const tier of TIERS) {
      tiers[tier].requests += num(item[`${tier}Requests`]);
      tiers[tier].ms += num(item[`${tier}Ms`]);
    }
    byDay.set(day, {
      day,
      gas: num(item.gasRequests),
      liquid: num(item.liquidRequests),
      crystal: num(item.crystalRequests),
    });
    if (item.gasHandlers !== undefined && day > gasSeen) [gasHandlers, gasSeen] = [num(item.gasHandlers), day];
    if (item.crystalHandlers !== undefined && day > crystalSeen) {
      [crystalHandlers, crystalSeen] = [num(item.crystalHandlers), day];
    }
  }
  const daily = monthDays(month).map((day) => byDay.get(day) ?? { day, gas: 0, liquid: 0, crystal: 0 });
  return finish({
    month,
    requests,
    generations,
    inputTokens,
    outputTokens,
    tiers,
    daily,
    gasHandlers,
    crystalHandlers,
    liquidHandlers,
  });
}

async function usageItems(endpointId: string, month: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const page = await ddb().send(
      new QueryCommand({
        TableName: env().controlTable,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :month)',
        // Trailing dash: day keys only, never a v1 monthly item keyed YYYY-MM.
        ExpressionAttributeValues: { ':pk': `USAGE#${endpointId}`, ':month': `${month}-` },
        ExclusiveStartKey,
      }),
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function countHandlers(endpointId: string): Promise<number> {
  let count = 0;
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const page = await ddb().send(
      new QueryCommand({
        TableName: env().handlersTable,
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
}

export async function endpointStats(endpointId: string, month = currentMonth()): Promise<Usage> {
  const [items, liquidHandlers] = await Promise.all([usageItems(endpointId, month), countHandlers(endpointId)]);
  return usageFromItems(month, items, liquidHandlers);
}

/** Sums several endpoints' Usage for the same month. */
export function combineUsage(month: string, list: Usage[]): Usage {
  const tiers = emptyTiers();
  const daily = monthDays(month).map((day) => ({ day, gas: 0, liquid: 0, crystal: 0 }));
  const sum = { requests: 0, generations: 0, inputTokens: 0, outputTokens: 0, liquidHandlers: 0 };
  let gasHandlers: number | null = null;
  let crystalHandlers: number | null = null;
  for (const u of list) {
    for (const key of Object.keys(sum) as (keyof typeof sum)[]) sum[key] += u[key];
    for (const tier of TIERS) {
      tiers[tier].requests += u.tiers[tier].requests;
      tiers[tier].ms += u.tiers[tier].ms;
    }
    u.daily.forEach((d, i) => {
      if (!daily[i]) return;
      daily[i].gas += d.gas;
      daily[i].liquid += d.liquid;
      daily[i].crystal += d.crystal;
    });
    if (u.gasHandlers !== null) gasHandlers = (gasHandlers ?? 0) + u.gasHandlers;
    if (u.crystalHandlers !== null) crystalHandlers = (crystalHandlers ?? 0) + u.crystalHandlers;
  }
  return finish({ month, ...sum, tiers, daily, gasHandlers, crystalHandlers });
}

export type EndpointWithStats = Endpoint & { stats: Usage };

export async function listWithStats(owner: string, month = currentMonth()): Promise<EndpointWithStats[]> {
  const endpoints = await listEndpoints(owner);
  return Promise.all(endpoints.map(async (ep) => ({ ...ep, stats: await endpointStats(ep.endpointId, month) })));
}

export function summarize(rows: EndpointWithStats[], month = currentMonth()): Overview {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const row of rows) if (row.status in byStatus) byStatus[row.status] += 1;
  return {
    ...combineUsage(
      month,
      rows.map((row) => row.stats),
    ),
    total: rows.length,
    byStatus,
  };
}

export async function overview(owner: string): Promise<Overview> {
  return summarize(await listWithStats(owner));
}
