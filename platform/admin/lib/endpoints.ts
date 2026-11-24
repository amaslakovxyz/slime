// Endpoint records in slime-control; their secrets live in the secret store.
// Two modes share these writes (Contract 3 of the cloud MVP design):
// - local: the admin writes `pending`, `updating` and `deleting`, and the local
//   runner (scripts/local-runner.ts) starts, restarts or tears down the process
//   and moves the item to ready|failed, or removes it;
// - cloud (SLIME_RUNTIME_URL set): create writes `provisioning` with the shared
//   runtime URL, and the server action finishes the transition in the same
//   request (lib/cloud-endpoints.ts).
import { randomBytes } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CONNECTOR_SPECS, validateConnectionUrl, type ConnectorType } from './connectors';
import { ddb } from './ddb';
import { env, isCloud } from './env';
import { CodedError } from './errors';
import { crystallizationSavings, estimateBill, TIERS, type Tier } from './pricing';
import { secretStore } from './secrets';

// Groq was dropped from the console on 2026-11-24: the cloud has no Groq key. The runtime still
// accepts SLIME_PROVIDER=groq for self-hosting; an endpoint saved with it moves to Claude on its
// next settings save.
export const PROVIDERS = ['claude'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const STATUSES = ['pending', 'provisioning', 'ready', 'failed', 'updating', 'deleting'] as const;
export type Status = (typeof STATUSES)[number];
/** States an endpoint is moving through; the UI polls while in one. */
export const TRANSIENT_STATUSES: readonly Status[] = ['pending', 'provisioning', 'updating', 'deleting'];

export interface Endpoint {
  endpointId: string;
  owner: string;
  name: string;
  provider: Provider;
  connectorType: ConnectorType;
  status: Status;
  tokenHint: string;
  /** Base URL the endpoint answers on, with a trailing slash (`new URL('v0/…', url)`). */
  url?: string;
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
  /** LLM tokens (input + output; the core reports one total). */
  tokens: number;
  tiers: Record<Tier, TierUsage>;
  /** Every day of the month up to today, zero-filled. */
  daily: DayUsage[];
  /** Handler snapshots from the instance that flushed last; null when never reported. */
  gasHandlers: number | null;
  liquidHandlers: number | null;
  crystalHandlers: number | null;
  estimatedUsd: number;
  savingsUsd: number;
}

export interface Overview extends Usage {
  total: number;
  byStatus: Record<Status, number>;
}

export const isProvider = (value: string): value is Provider => (PROVIDERS as readonly string[]).includes(value);

const ownerKey = (owner: string) => `USER#${owner}`;
export const endpointKey = (owner: string, endpointId: string) => ({ pk: ownerKey(owner), sk: `ENDPOINT#${endpointId}` });
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
  // Secrets first: the runner (local) or the runtime (cloud) reads them as soon as the item exists.
  await secrets.put(endpointId, CONNECTOR_SPECS[connectorType].secret, databaseUrl);
  await secrets.put(endpointId, 'SLIME_API_KEY', token);
  await secrets.put(endpointId, 'SLIME_PROVIDER', provider);
  const { runtimeUrl } = env();

  const now = new Date().toISOString();
  const item: Endpoint & { pk: string; sk: string; type: 'endpoint' } = {
    ...endpointKey(owner, endpointId),
    type: 'endpoint',
    endpointId,
    owner,
    name,
    provider,
    connectorType,
    // Cloud: the shared runtime already serves this id; the create action health-checks it next.
    ...(runtimeUrl ? { status: 'provisioning' as const, url: `${runtimeUrl}ep/${endpointId}/` } : { status: 'pending' as const }),
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

export async function requireEndpoint(owner: string, endpointId: string): Promise<Endpoint> {
  const ep = await getEndpoint(owner, endpointId);
  if (!ep) throw new CodedError('NOT_FOUND', 'Endpoint not found');
  return ep;
}

const notUpdatable = (message: string) => new CodedError('NOT_UPDATABLE', message);

/**
 * The admin Lambda times out at 60 s; a cloud delete still `deleting` after this was cut
 * off mid-teardown, and Delete may start it again (the teardown is idempotent).
 */
export const STALE_DELETE_MS = 90_000;

/** Cloud only: a `deleting` endpoint whose teardown was interrupted, so Delete is offered again. */
export const isStaleDelete = (ep: Pick<Endpoint, 'status' | 'updatedAt'>, now = Date.now()): boolean =>
  ep.status === 'deleting' && now - Date.parse(ep.updatedAt) > STALE_DELETE_MS;

/**
 * Moves the item to `deleting`. Locally only from ready|failed (the runner owns the
 * other states). In the cloud from any state: an admin Lambda that timed out mid-action
 * can leave `provisioning`, `updating` or a half-done `deleting` behind, and Delete is the
 * way out. A `deleting` that is still fresh belongs to a delete in progress and is refused.
 */
export async function requestDelete(owner: string, endpointId: string): Promise<void> {
  const cloud = isCloud();
  const now = Date.now();
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: env().controlTable,
        Key: endpointKey(owner, endpointId),
        UpdateExpression: 'SET #s = :deleting, updatedAt = :now',
        ConditionExpression: cloud ? 'attribute_exists(pk) AND (#s <> :deleting OR updatedAt < :stale)' : '#s IN (:ready, :failed)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':deleting': 'deleting',
          ':now': new Date(now).toISOString(),
          ...(cloud ? { ':stale': new Date(now - STALE_DELETE_MS).toISOString() } : { ':ready': 'ready', ':failed': 'failed' }),
        },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new CodedError(
        'NOT_DELETABLE',
        cloud ? 'The endpoint is already being deleted' : 'Only ready or failed endpoints can be deleted',
      );
    }
    throw err;
  }
}

/**
 * Replaces the connection secret. A pending endpoint has not read it yet, so the
 * secret is all that changes; a ready|failed one goes to `updating` so the runner
 * restarts it (local) or the action reloads and re-checks it (cloud).
 * Returns whether the endpoint went to `updating`.
 */
export async function updateConnector(
  owner: string,
  endpointId: string,
  input: { connectorType: string; databaseUrl: string },
): Promise<boolean> {
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
  return redeploy;
}

/**
 * Rename works in any state but deleting; a provider change goes to `updating`, so
 * only from ready|failed. Returns whether the endpoint went to `updating`.
 */
export async function updateSettings(
  owner: string,
  endpointId: string,
  input: { name: string; provider: string },
): Promise<boolean> {
  const name = validateName(input.name);
  const provider = validateProvider(input.provider);
  const ep = await requireEndpoint(owner, endpointId);
  if (ep.status === 'deleting') throw notUpdatable('The endpoint is being deleted');
  const providerChanged = provider !== ep.provider;
  if (providerChanged && ep.status !== 'ready' && ep.status !== 'failed') {
    throw notUpdatable(`The provider can change only when ready or failed (now ${ep.status})`);
  }
  if (!providerChanged && name === ep.name) return false;

  // The runtime reads the provider from the secrets (the item keeps it for display): write it
  // first, so the restart or reload that `updating` starts already sees it.
  const secrets = secretStore();
  const previous = providerChanged ? await secrets.get(endpointId, 'SLIME_PROVIDER') : undefined;
  if (providerChanged) await secrets.put(endpointId, 'SLIME_PROVIDER', provider, { overwrite: true });
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
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // Endpoints created before the provider secret existed fall back to the item's provider.
    if (providerChanged) await secrets.put(endpointId, 'SLIME_PROVIDER', previous ?? ep.provider, { overwrite: true });
    throw notUpdatable('The endpoint changed state meanwhile; reload and try again');
  }
  return providerChanged;
}

/** Local mode, after a Crystallize: the runner restarts the endpoint so it loads the new Crystal modules. */
export async function requestRestart(owner: string, endpointId: string): Promise<void> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: env().controlTable,
        Key: endpointKey(owner, endpointId),
        UpdateExpression: 'SET #s = :updating, updatedAt = :now',
        ConditionExpression: '#s = :ready',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':updating': 'updating', ':ready': 'ready', ':now': new Date().toISOString() },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) throw notUpdatable('The endpoint is not ready');
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

/** Per-tier handler counts the runtime reports as a snapshot (not a counter). */
const SNAPSHOTS = ['gasHandlers', 'liquidHandlers', 'crystalHandlers'] as const;
type Snapshots = Record<(typeof SNAPSHOTS)[number], number | null>;
const emptySnapshots = (): Snapshots => ({ gasHandlers: null, liquidHandlers: null, crystalHandlers: null });

/** Sums a month's day items (any order) into Usage. */
export function usageFromItems(month: string, items: Record<string, unknown>[]): Usage {
  const tiers = emptyTiers();
  const byDay = new Map<string, DayUsage>();
  let requests = 0;
  let generations = 0;
  let tokens = 0;
  // Latest reported value per snapshot attribute; a day without one keeps the earlier value.
  const snapshots = emptySnapshots();
  const seen = { gasHandlers: '', liquidHandlers: '', crystalHandlers: '' };
  for (const item of items) {
    const day = String(item.sk);
    requests += num(item.requests);
    generations += num(item.generations);
    tokens += num(item.tokens);
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
    for (const key of SNAPSHOTS) {
      if (item[key] !== undefined && day > seen[key]) [snapshots[key], seen[key]] = [num(item[key]), day];
    }
  }
  const daily = monthDays(month).map((day) => byDay.get(day) ?? { day, gas: 0, liquid: 0, crystal: 0 });
  return finish({ month, requests, generations, tokens, tiers, daily, ...snapshots });
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

export async function endpointStats(endpointId: string, month = currentMonth()): Promise<Usage> {
  return usageFromItems(month, await usageItems(endpointId, month));
}

/** Sums several endpoints' Usage for the same month. */
export function combineUsage(month: string, list: Usage[]): Usage {
  const tiers = emptyTiers();
  const daily = monthDays(month).map((day) => ({ day, gas: 0, liquid: 0, crystal: 0 }));
  const sum = { requests: 0, generations: 0, tokens: 0 };
  const snapshots = emptySnapshots();
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
    for (const key of SNAPSHOTS) {
      const value = u[key];
      if (value !== null) snapshots[key] = (snapshots[key] ?? 0) + value;
    }
  }
  return finish({ month, ...sum, tiers, daily, ...snapshots });
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
