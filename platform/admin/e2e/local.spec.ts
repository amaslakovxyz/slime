// CUJs 1-4 on the local stack (`npm run local`, started by the config with
// ADMIN_ALLOWED_EMAILS=e2e@example.com): invite-only sign-up, create -> ready,
// Gas -> Liquid through the dispatch endpoint, Crystallize, the Crystal route with
// its own token, delete. Needs DynamoDB Local with the tables and the demo Postgres.
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createEndpoint, DEMO_QUERY, deleteEndpoint, endpointUrl, expectStatus, expectSignupRefused, lifecycleJourney, PASSWORD, signIn } from './helpers';

const DEMO_DB = 'postgres://slime_reader:slime_reader@localhost:54329/slime';

test('invited developer: sign up, create, Gas -> Liquid -> Crystal, call the Crystal route, delete', async ({ page, request }) => {
  const run = randomBytes(3).toString('hex');

  await test.step('CUJ 1: a non-invited email is refused, the invited one gets in', async () => {
    await expectSignupRefused(page, `other-${run}@example.com`);
    await signIn(page, 'e2e@example.com', PASSWORD);
  });

  await lifecycleJourney(page, request, { name: `e2e-${run}`, databaseUrl: DEMO_DB });
});

test('Requests log: a request opens its non-modal trace drawer, arrows walk between rows, Esc closes it', async ({ page, request }) => {
  const run = randomBytes(3).toString('hex');
  await signIn(page, 'e2e@example.com', PASSWORD);
  const id = await createEndpoint(page, { name: `trace-${run}`, provider: 'claude', databaseUrl: DEMO_DB });
  await expectStatus(page, 'ready');
  const url = await endpointUrl(page);

  const apiKey = await test.step('reveal the endpoint key', async () => {
    await page.getByRole('button', { name: 'Reveal token' }).click();
    await expect(page.getByTestId('agent-snippet')).toContainText(/slm_[\w-]{8,}/);
    return (await page.getByTestId('agent-snippet').textContent())!.match(/slm_[\w-]+/)![0];
  });

  await test.step('two requests fill the log with two rows', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await request.post(`${url}v0/query`, { headers: { 'x-api-key': apiKey }, data: DEMO_QUERY });
      expect(res.status(), await res.text()).toBe(200);
    }
  });

  await test.step('click the first row: a dialog-less drawer opens on Layers with a Parse & key row', async () => {
    await page.goto(`/endpoints/${id}/requests`);
    await page.locator('tbody tr.trace-row').first().click();
    const drawer = page.getByRole('complementary', { name: 'Request trace' });
    await expect(drawer).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0); // non-modal
    await expect(drawer.getByRole('tab', { name: 'Layers' })).toHaveAttribute('aria-selected', 'true');
    await expect(drawer.getByText('Parse & key')).toBeVisible();
  });

  await test.step('ArrowDown selects the next request; Escape closes the drawer', async () => {
    const title = page.locator('.trace-d-top .mono').first();
    const before = await title.textContent();
    await page.keyboard.press('ArrowDown');
    await expect(title).not.toHaveText(before!);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary', { name: 'Request trace' })).toBeHidden();
  });

  await deleteEndpoint(page, id);
});
