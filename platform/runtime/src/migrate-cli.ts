// npm run migrate [-- --dry-run]: copies the sandbox runtime's Liquid handlers for
// SLIME_TENANT_ID in SLIME_HANDLERS_TABLE into the core's format. Run it once,
// with AWS credentials that may Query, GetItem and PutItem on the table,
// before deploying the runtime built on @slime-cloud/core.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { migrateLegacyHandlers } from './legacy-handlers.js';
import { DynamoSlimeStore } from './store-dynamodb.js';

const table = process.env.SLIME_HANDLERS_TABLE ?? '';
const tenantId = process.env.SLIME_TENANT_ID ?? '';
const isDryRun = process.argv.includes('--dry-run');

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const store = new DynamoSlimeStore({ table, tenantId, client });
const reports = await migrateLegacyHandlers({ client, table, tenantId, store, isDryRun });
for (const { outcome, intent, reason } of reports) console.log(`${outcome}: ${intent}${reason ? ` (${reason})` : ''}`);
console.log(`${isDryRun ? 'dry run: ' : ''}${reports.filter(({ outcome }) => outcome === 'copied').length} handler(s) copied for tenant ${tenantId}`);
