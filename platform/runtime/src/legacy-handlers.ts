// Copies Liquid handlers the sandbox engine saved into the core's format (M7).
// Locked mode can't regenerate, so without this the switch would leave a
// tenant with nothing to serve. The old items stay where they are, so the
// previous runtime still works after a rollback.
import { handlerKeyFor, type HandlerRecord, type ParamTypes, type ReviewStatus } from '@slime-cloud/core';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DocClient, DynamoSlimeStore } from './store-dynamodb.js';

/** What the sandbox's DynamoHandlerStore wrote: the handler as JSON plus runs and fixtures beside it. */
export interface LegacyItem {
  artifactKey: string;
  handler: string;
  fixtures: string;
  runs: number | string;
}

interface LegacyHandler {
  intent: string;
  inputSig: Record<string, string>;
  output: HandlerRecord['output'];
  artifact: HandlerRecord['artifact'];
  schemaHash: string;
  promptHash: string;
  model: string;
  review: { status: string };
  createdAt: string;
}

export interface MigrationOptions {
  client: DocClient;
  table: string;
  tenantId: string;
  store: DynamoSlimeStore;
  isDryRun?: boolean;
}

export interface MigrationReport {
  key: string;
  intent: string;
  outcome: 'copied' | 'already there' | 'superseded' | 'skipped';
  reason?: string;
}

const HANDLERS_NS = 'handlers';
const NAMESPACE_SEPARATOR = '#';
// The sandbox's per-value JSON types (fingerprint.ts) → the core's coarse types (R4).
const COARSE_TYPES: Readonly<Record<string, ParamTypes[string]>> = {
  string: 'string',
  integer: 'number',
  number: 'number',
  boolean: 'boolean',
  array: 'list',
  null: null,
};

export async function migrateLegacyHandlers({ client, table, tenantId, store, isDryRun = false }: MigrationOptions): Promise<MigrationReport[]> {
  const records = (await legacyItems(client, table, tenantId)).map(toHandlerRecord);
  const reports: MigrationReport[] = [];
  for (const record of mostRunPerKey(records, reports)) {
    if ((await store.get(HANDLERS_NS, record.key)) !== undefined) {
      reports.push({ key: record.key, intent: record.intent, outcome: 'already there' });
      continue;
    }
    if (!isDryRun) await store.put(HANDLERS_NS, record.key, record);
    reports.push({ key: record.key, intent: record.intent, outcome: 'copied' });
  }
  return reports;
}

/** The core keys by request; several sandbox items (other input types or scopes) can share one key. */
function mostRunPerKey(records: HandlerRecord[], reports: MigrationReport[]): HandlerRecord[] {
  const byKey = new Map<string, HandlerRecord>();
  for (const record of records) {
    const kept = byKey.get(record.key);
    const [winner, loser] = !kept || record.runs > kept.runs ? [record, kept] : [kept, record];
    byKey.set(record.key, winner);
    if (loser) reports.push({ key: loser.key, intent: loser.intent, outcome: 'superseded', reason: `kept the version with ${winner.runs} runs` });
  }
  return [...byKey.values()];
}

export function toHandlerRecord(item: LegacyItem): HandlerRecord {
  const legacy = JSON.parse(item.handler) as LegacyHandler;
  const fixtures = (JSON.parse(item.fixtures) as { input: HandlerRecord['fixtures'][number] }[]).map(({ input }) => input);
  const inputNames = Object.fromEntries(Object.keys(legacy.inputSig).map((name) => [name, null]));
  return {
    key: handlerKeyFor({ intent: legacy.intent, input: inputNames, output: legacy.output }),
    intent: legacy.intent,
    output: legacy.output,
    artifact: legacy.artifact,
    paramTypes: Object.fromEntries(Object.entries(legacy.inputSig).map(([name, type]) => [name, COARSE_TYPES[type] ?? null])),
    // The sandbox scope had no dictionary, so a migrated handler is generated again on its first request (§4.7).
    provenance: { schemaHash: legacy.schemaHash, dictionaryHash: 'sandbox', promptHash: legacy.promptHash, model: legacy.model },
    tier: 'liquid',
    review: reviewStatusOf(legacy.review.status),
    runs: Number(item.runs),
    fixtures,
    createdAt: legacy.createdAt,
  };
}

function reviewStatusOf(sandboxStatus: string): ReviewStatus {
  return sandboxStatus === 'approved' ? 'approved' : 'none';
}

async function legacyItems(client: DocClient, table: string, tenantId: string): Promise<LegacyItem[]> {
  const items: LegacyItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({ TableName: table, KeyConditionExpression: 'tenantId = :tenant', ExpressionAttributeValues: { ':tenant': tenantId }, ConsistentRead: true, ExclusiveStartKey }),
    );
    for (const item of page.Items ?? []) if (!String(item.artifactKey).includes(NAMESPACE_SEPARATOR)) items.push(item as LegacyItem);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}
