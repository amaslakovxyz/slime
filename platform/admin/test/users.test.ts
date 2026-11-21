// Invite-only sign-up (ADMIN_ALLOWED_EMAILS) against DynamoDB Local. Skipped when
// it is not reachable, unless REQUIRE_DYNAMO=1 (CI), where that is a failure.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { after, afterEach, before, describe, test } from 'node:test';
import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { createDevTables } from '../scripts/dev-tables';
import { ddb } from '../lib/ddb';
import { hasCode } from '../lib/errors';
import { checkLogin, createUser } from '../lib/users';

process.env.AWS_ENDPOINT_URL_DYNAMODB ??= 'http://localhost:8000';
process.env.AWS_REGION ??= 'eu-central-1';
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'local';
process.env.SESSION_SECRET ??= 'test-secret-that-is-at-least-32-characters';

const suffix = randomBytes(4).toString('hex');
const tables = { control: `test-control-${suffix}`, handlers: `test-handlers-${suffix}` };
process.env.SLIME_CONTROL_TABLE = tables.control;

const endpointUrl = new URL(process.env.AWS_ENDPOINT_URL_DYNAMODB);
const reachable = await new Promise<boolean>((resolve) => {
  const socket = connect(Number(endpointUrl.port || 80), endpointUrl.hostname);
  socket.setTimeout(1000);
  socket.once('connect', () => (socket.destroy(), resolve(true)));
  socket.once('timeout', () => (socket.destroy(), resolve(false)));
  socket.once('error', () => resolve(false));
});
const skip = reachable || process.env.REQUIRE_DYNAMO === '1' ? false : 'DynamoDB Local is not reachable';

const email = (name: string) => `${name}-${suffix}@example.com`;
const stored = async (address: string) =>
  (await ddb().send(new GetCommand({ TableName: tables.control, Key: { pk: `USER#${address}`, sk: 'PROFILE' } }))).Item;

describe('invite-only sign-up (DynamoDB Local)', { skip }, () => {
  const client = new DynamoDBClient({});

  before(() => createDevTables(client, tables));
  afterEach(() => {
    delete process.env.ADMIN_ALLOWED_EMAILS;
    delete process.env.SLIME_RUNTIME_URL;
  });
  after(async () => {
    for (const TableName of Object.values(tables)) await client.send(new DeleteTableCommand({ TableName })).catch(() => {});
  });

  test('an invited email signs up whatever its case; the list itself is trimmed and case-blind', async () => {
    const invited = email('dev');
    process.env.ADMIN_ALLOWED_EMAILS = ` ${invited.toUpperCase()} , ${email('ops')}`;
    assert.equal(await createUser(`  ${invited.replace('dev', 'DeV')} `, 'password123'), invited);
    assert.equal(await checkLogin(invited, 'password123'), true);
  });

  test('an email that is not invited is refused and leaves no user record', async () => {
    process.env.ADMIN_ALLOWED_EMAILS = email('dev2');
    const stranger = email('other');
    await assert.rejects(createUser(stranger, 'password123'), (err) => hasCode(err, 'NOT_INVITED'));
    assert.equal(await stored(stranger), undefined);
    // A weak password does not reveal that the email would be accepted.
    await assert.rejects(createUser(email('other2'), 'short'), (err) => hasCode(err, 'NOT_INVITED'));
  });

  test('an allowlist that is set but empty invites nobody', async () => {
    process.env.ADMIN_ALLOWED_EMAILS = ' , ';
    await assert.rejects(createUser(email('anyone'), 'password123'), (err) => hasCode(err, 'NOT_INVITED'));
  });

  test('the hosted admin without an allowlist invites nobody (a missing SSM parameter never opens sign-up)', async () => {
    process.env.SLIME_RUNTIME_URL = 'https://runtime.example/';
    const stranger = email('cloud');
    await assert.rejects(createUser(stranger, 'password123'), (err) => hasCode(err, 'NOT_INVITED'));
    assert.equal(await stored(stranger), undefined);
  });

  test('without an allowlist sign-up is open, and a user created then still signs in once one is set', async () => {
    const early = email('early');
    await createUser(early, 'password123');
    process.env.ADMIN_ALLOWED_EMAILS = email('someone-else');
    assert.equal(await checkLogin(early, 'password123'), true);
  });
});
