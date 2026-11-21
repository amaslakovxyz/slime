// CUJs 1-4 on the local stack (`npm run local`, started by the config with
// ADMIN_ALLOWED_EMAILS=e2e@example.com): invite-only sign-up, create -> ready,
// Gas -> Liquid through the dispatch endpoint, Crystallize, the Crystal route with
// its own token, delete. Needs DynamoDB Local with the tables and the demo Postgres.
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createEndpoint, deleteEndpoint, endpointUrl, expectSignupRefused, expectStatus, PASSWORD, signIn } from './helpers';

const DEMO_DB = 'postgres://slime_reader:slime_reader@localhost:54329/slime';
/** One of the Offline provider's canned handlers; `limit` becomes the Crystal route's input. */
const QUERY = {
  intent: 'top N accounts by total paid invoice amount in cents, highest first',
  input: { limit: 5 },
  output: [{ name: 'string', totalPaidCents: 'integer' }],
};

test('invited developer: sign up, create, Gas -> Liquid -> Crystal, call the Crystal route, delete', async ({ page, request }) => {
  const run = randomBytes(3).toString('hex');

  await test.step('CUJ 1: a non-invited email is refused, the invited one gets in', async () => {
    await expectSignupRefused(page, `other-${run}@example.com`);
    await signIn(page, 'e2e@example.com', PASSWORD);
  });

  const name = `e2e-${run}`;
  const id = await test.step('CUJ 2: create on the demo database -> ready', async () => {
    const endpointId = await createEndpoint(page, { name, provider: 'offline', databaseUrl: DEMO_DB });
    await expectStatus(page, 'ready');
    return endpointId;
  });
  const url = await endpointUrl(page);

  const apiKey = await test.step('reveal the endpoint key in the agent snippet', async () => {
    await page.getByRole('button', { name: 'Reveal token' }).click();
    await expect(page.getByTestId('agent-snippet')).toContainText(/slm_[\w-]{8,}/);
    return /slm_[\w-]+/.exec((await page.getByTestId('agent-snippet').textContent())!)![0];
  });

  await test.step('CUJ 3: twelve requests turn the handler Liquid and ready to crystallize', async () => {
    for (let i = 0; i < 12; i++) {
      const res = await request.post(`${url}v0/query`, { headers: { 'x-api-key': apiKey }, data: QUERY });
      expect(res.status(), await res.text()).toBe(200);
    }
    await expect(page.getByRole('button', { name: /^Crystallize / })).toBeVisible({ timeout: 60_000 });
  });

  await test.step('Crystallize, then the restart brings the Crystal card', async () => {
    await page.getByRole('button', { name: /^Crystallize / }).click();
    await expect(page.locator('.lc-reports li.ok')).toContainText('crystallized', { timeout: 60_000 });
    await expect(page.getByTestId('crystal-card')).toBeVisible({ timeout: 60_000 });
    await expectStatus(page, 'ready');
  });

  await test.step('the Crystal token opens its own route and nothing else', async () => {
    const card = page.getByTestId('crystal-card');
    const key = (await card.getAttribute('data-key'))!;
    await card.getByRole('button', { name: 'Reveal' }).click();
    // The masked hint also starts with slc_ (slc_••••abcd); wait for the revealed base64url token.
    await expect(card.getByTestId('crystal-token')).toHaveText(/^slc_[A-Za-z0-9_-]+$/);
    const token = (await card.getByTestId('crystal-token').textContent())!.trim();

    const crystal = await request.post(`${url}v0/e/${key}`, { headers: { 'x-api-key': token }, data: { input: QUERY.input } });
    expect(crystal.status(), await crystal.text()).toBe(200);
    expect((await crystal.json()).meta.tier).toBe('crystal');

    const dispatch = await request.post(`${url}v0/query`, { headers: { 'x-api-key': token }, data: QUERY });
    expect(dispatch.status()).toBe(401);
  });

  await test.step('CUJ 4: delete removes the endpoint from the list', async () => {
    await deleteEndpoint(page, id);
  });
});
