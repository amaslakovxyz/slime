// Seeds demo usage into DynamoDB Local so the charts have something to show:
// one usage item per UTC day of the current month up to today (whole-item
// PUTs, so re-seeding overwrites older shapes). Refuses to run without
// AWS_ENDPOINT_URL_DYNAMODB so it can never write into real AWS.
//
//   npm run seed -- ep-3a7770c7f6 [ep-...]
//   npm run seed -- --owner demo@slime.dev
//
// The traffic tells the crystallization story: early in the month most requests
// hit Gas (generation, 150-400 ms); as handlers settle, Liquid (2-8 ms) and
// Crystal (<2 ms) take over and generations and LLM tokens dry up.
import { existsSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

// Deterministic per endpoint, so re-seeding draws the same month.
function rng(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function demoDays(endpointId: string, now = new Date()) {
  const rand = rng(endpointId);
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const inMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const items: Record<string, string | number>[] = [];
  for (let d = 1; d <= now.getUTCDate(); d++) {
    const date = new Date(Date.UTC(year, month, d));
    const progress = (d - 1) / (inMonth - 1);
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    const requests = Math.round((380 + d * 70) * (weekend ? 0.55 : 1) * between(0.8, 1.2));
    const gasShare = 0.04 + 0.6 * Math.exp(-4.5 * progress);
    const crystalShare = Math.min(0.7, 0.03 + 0.85 * progress) * (1 - gasShare);
    const gasRequests = Math.max(1, Math.round(requests * gasShare));
    const crystalRequests = Math.round(requests * crystalShare);
    const liquidRequests = requests - gasRequests - crystalRequests;
    // Generations are Gas misses; later in the month most Gas traffic reuses a warm handler.
    const generations = Math.round(gasRequests * (0.05 + 0.35 * Math.exp(-3 * progress)) * between(0.6, 1.4));
    const spike = generations > 0 ? Math.min(1, generations / gasRequests) * 220 : 0;
    const gasAvg = Math.min(400, between(150, 200) + spike);
    items.push({
      sk: date.toISOString().slice(0, 10),
      requests,
      generations,
      gasRequests,
      liquidRequests,
      crystalRequests,
      gasMs: Math.round(gasRequests * gasAvg),
      liquidMs: Math.round(liquidRequests * between(2, 8)),
      crystalMs: Math.round(crystalRequests * between(0.3, 1.6)),
      tokens: generations * Math.round(between(2100, 3300)),
      gasHandlers: Math.max(1, Math.round(9 - 7 * progress + between(-1, 1))),
      liquidHandlers: Math.round(2 + 10 * progress),
      crystalHandlers: Math.round(14 * progress + between(0, 1)),
      updatedAt: d === now.getUTCDate() ? now.toISOString() : new Date(Date.UTC(year, month, d, 23, 59)).toISOString(),
    });
  }
  return items;
}

async function endpointsOf(doc: DynamoDBDocumentClient, table: string, owner: string): Promise<string[]> {
  const out = await doc.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `USER#${owner.toLowerCase()}`, ':prefix': 'ENDPOINT#' },
    }),
  );
  return (out.Items ?? []).map((item) => String(item.endpointId));
}

async function main() {
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  if (!process.env.AWS_ENDPOINT_URL_DYNAMODB) {
    console.error('AWS_ENDPOINT_URL_DYNAMODB is not set; refusing to seed outside DynamoDB Local.');
    process.exit(1);
  }
  const controlTable = process.env.SLIME_CONTROL_TABLE || 'slime-control';
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  const args = process.argv.slice(2);
  const ownerAt = args.indexOf('--owner');
  const ids = ownerAt >= 0 ? await endpointsOf(doc, controlTable, args[ownerAt + 1] ?? '') : args;
  if (ids.length === 0) {
    console.error('Usage: npm run seed -- <endpointId> [...] | --owner <email>  (no endpoints found)');
    process.exit(1);
  }

  for (const id of ids) {
    const days = demoDays(id);
    for (const day of days) {
      await doc.send(new PutCommand({ TableName: controlTable, Item: { pk: `USAGE#${id}`, ...day } }));
    }
    const requests = days.reduce((sum, d) => sum + Number(d.requests), 0);
    console.log(`${id}: ${days.length} days, ${requests} requests, ${days.at(-1)?.liquidHandlers ?? 0} Liquid handlers`);
  }
}

await main();
