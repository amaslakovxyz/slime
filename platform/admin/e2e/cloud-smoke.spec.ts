// The hosted admin and the shared runtime.
// - Goal 10, always: sign-in, create -> failed with the database reason, the endpoint
//   URL refusing a request without a key, an unknown id answering 404, and delete.
// - With SMOKE_DB_URL (a read-only URL to a database with the demo schema, e.g. the
//   temporary test RDS): the whole lifecycle on AWS, Gas -> Liquid -> Crystal.
// SMOKE_EMAIL must be in /slime/admin/ADMIN_ALLOWED_EMAILS; the account is created on
// the first run. With AWS credentials in the environment the SSM path is checked too.
import { randomBytes } from 'node:crypto';
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { expect, test } from '@playwright/test';
import { createEndpoint, deleteEndpoint, endpointUrl, expectStatus, lifecycleJourney, signIn } from './helpers';

const EMAIL = process.env.SMOKE_EMAIL;
const SMOKE_PASSWORD = process.env.SMOKE_PASSWORD;
const SMOKE_DB_URL = process.env.SMOKE_DB_URL;
/** `.invalid` never resolves, so the runtime fails fast with a DNS error instead of a connect timeout. */
const UNREACHABLE_DB = 'postgres://smoke:smoke@unreachable.invalid:5432/smoke';

/** Parameter names under the endpoint's SSM path, or undefined without AWS credentials. */
async function ssmNames(endpointId: string): Promise<string[] | undefined> {
  try {
    const out = await new SSMClient({ region: process.env.AWS_REGION || 'eu-central-1' }).send(
      new GetParametersByPathCommand({ Path: `/slime/endpoints/${endpointId}/` }),
    );
    return (out.Parameters ?? []).flatMap((p) => (p.Name ? [p.Name] : []));
  } catch (err) {
    if ((err as Error).name === 'CredentialsProviderError') return undefined;
    throw err;
  }
}

test.describe('cloud smoke (Goal 10)', () => {
  test.skip(!EMAIL || !SMOKE_PASSWORD, 'SMOKE_EMAIL and SMOKE_PASSWORD are not set');
  let leftover: string | undefined;

  test.afterAll(async ({ browser }) => {
    if (!leftover) return;
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const page = await context.newPage();
    await signIn(page, EMAIL!, SMOKE_PASSWORD!);
    await deleteEndpoint(page, leftover);
    await context.close();
  });

  test('sign in, create fails with the database reason, the endpoint is guarded, delete removes it', async ({ page, request }) => {
    await signIn(page, EMAIL!, SMOKE_PASSWORD!);

    const id = await createEndpoint(page, { name: `smoke-${randomBytes(3).toString('hex')}`, provider: 'offline', databaseUrl: UNREACHABLE_DB });
    leftover = id;
    await expectStatus(page, 'failed', 5_000);
    await expect(page.getByText(/^Endpoint failed: /)).toContainText(/ENOTFOUND|getaddrinfo|unreachable\.invalid/i);

    const url = await endpointUrl(page);
    expect(url).toMatch(new RegExp(`/ep/${id}/$`));
    const body = { intent: 'number of accounts on each plan', input: {}, output: [{ plan: 'string', accounts: 'integer' }] };
    expect((await request.post(`${url}v0/query`, { data: body })).status()).toBe(401);
    const unknown = url.replace(/ep\/ep-[0-9a-f]{10}\/$/, 'ep/ep-0000000000/');
    expect((await request.post(`${unknown}v0/query`, { data: body })).status()).toBe(404);

    expect(await ssmNames(id)).not.toEqual([]);
    await deleteEndpoint(page, id);
    leftover = undefined;
    const names = await ssmNames(id);
    if (names === undefined) test.info().annotations.push({ type: 'skipped', description: 'no AWS credentials: SSM path not checked' });
    else expect(names).toEqual([]);
  });

  test('the whole lifecycle on the test database: create -> ready, Liquid, Crystallize, the Crystal route, delete', async ({ page, request }) => {
    test.skip(!SMOKE_DB_URL, 'SMOKE_DB_URL is not set (no cloud test database)');
    // Twelve queries, a Crystallize and a settings TTL for the new Crystal token.
    test.setTimeout(240_000);
    await signIn(page, EMAIL!, SMOKE_PASSWORD!);
    await lifecycleJourney(page, request, { name: `smoke-db-${randomBytes(3).toString('hex')}`, databaseUrl: SMOKE_DB_URL! });
  });
});
