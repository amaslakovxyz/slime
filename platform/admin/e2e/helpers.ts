// UI steps both E2E projects share, written against what a user sees (labels,
// buttons, the status badge) rather than component internals.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = 'e2e-password-123';

async function fillCredentials(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
}

/** Sign-up that must be refused for an email that is not on the allowlist. */
export async function expectSignupRefused(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await fillCredentials(page, email, PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  // Next renders its own empty role="alert" route announcer; match the form's alert by its text.
  await expect(page.getByRole('alert').filter({ hasText: 'This email is not invited' })).toBeVisible();
}

/** Logs in, or creates the account first when it does not exist yet (re-runs reuse it). */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await fillCredentials(page, email, password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL((url) => url.pathname !== '/login' || url.searchParams.has('error'));
  if (new URL(page.url()).pathname === '/login') {
    await fillCredentials(page, email, password);
    await page.getByRole('button', { name: 'Create account' }).click();
  }
  await expect(page).toHaveURL((url) => url.pathname === '/');
}

/** Submits New endpoint and returns the id from the page it opens. */
export async function createEndpoint(page: Page, input: { name: string; provider: string; databaseUrl: string }): Promise<string> {
  await page.goto('/endpoints/new');
  await page.getByLabel('Name', { exact: true }).fill(input.name);
  // The radio sits under its styled label (the label's text intercepts the pointer), so click the label like a user does.
  const provider = page.locator(`input[name="provider"][value="${input.provider}"]`);
  await page.locator('label.choice', { has: provider }).click();
  await expect(provider).toBeChecked();
  await page.locator('input[name="databaseUrl"]').fill(input.databaseUrl);
  await page.getByRole('button', { name: 'Create endpoint' }).click();
  // Cloud create health-checks in the request, up to the 20 s window.
  await page.waitForURL(/\/endpoints\/ep-[0-9a-f]{10}\/lifecycle$/, { timeout: 45_000 });
  return /\/endpoints\/(ep-[0-9a-f]{10})\//.exec(page.url())![1]!;
}

/** The header badge; the page re-renders every 5 s while the status is transient. */
export async function expectStatus(page: Page, status: string, timeout = 30_000): Promise<void> {
  await expect(page.locator('.ep-head .badge')).toHaveText(status, { timeout });
}

/** The endpoint URL shown in the header, with its trailing slash. */
export async function endpointUrl(page: Page): Promise<string> {
  return (await page.locator('.ep-head .copy-field code').textContent())!.trim();
}

/** Deletes from Settings (accepting the confirm) and waits until the list no longer shows the id. */
export async function deleteEndpoint(page: Page, endpointId: string): Promise<void> {
  await page.goto(`/endpoints/${endpointId}/settings`);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete endpoint' }).click();
  await page.waitForURL((url) => url.pathname === '/endpoints');
  // Locally the runner removes a `deleting` item on its next tick.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(endpointId)).toHaveCount(0);
  }).toPass({ timeout: 30_000 });
}

/** One of the Offline provider's canned handlers on the demo schema; `limit` becomes the Crystal route's input. */
export const OFFLINE_QUERY = {
  intent: 'top N accounts by total paid invoice amount in cents, highest first',
  input: { limit: 5 },
  output: [{ name: 'string', totalPaidCents: 'integer' }],
};

/**
 * CUJs 2-4 on a database with the demo schema (examples/express/db/init.sql), signed in:
 * create -> ready, Gas -> Liquid through the dispatch endpoint, Crystallize, the Crystal
 * route with its own token, delete. Locally and in the cloud alike.
 */
export async function lifecycleJourney(
  page: Page,
  request: APIRequestContext,
  { name, databaseUrl, onCreated }: { name: string; databaseUrl: string; /** So a failed run can still delete what it made. */ onCreated?: (endpointId: string) => void },
): Promise<void> {
  const id = await test.step('CUJ 2: create on the demo database -> ready', async () => {
    const endpointId = await createEndpoint(page, { name, provider: 'offline', databaseUrl });
    onCreated?.(endpointId);
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
      const res = await request.post(`${url}v0/query`, { headers: { 'x-api-key': apiKey }, data: OFFLINE_QUERY });
      expect(res.status(), await res.text()).toBe(200);
    }
    await expect(page.getByRole('button', { name: /^Crystallize / })).toBeVisible({ timeout: 60_000 });
  });

  await test.step('Crystallize brings the Crystal card', async () => {
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

    // In the cloud other warm instances pick the new token up within the settings TTL (30 s).
    await expect(async () => {
      const crystal = await request.post(`${url}v0/e/${key}`, { headers: { 'x-api-key': token }, data: { input: OFFLINE_QUERY.input } });
      expect(crystal.status(), await crystal.text()).toBe(200);
      expect((await crystal.json()).meta.tier).toBe('crystal');
    }).toPass({ timeout: 45_000, intervals: [1_000, 5_000] });

    const dispatch = await request.post(`${url}v0/query`, { headers: { 'x-api-key': token }, data: OFFLINE_QUERY });
    expect(dispatch.status()).toBe(401);
  });

  await test.step('CUJ 4: delete removes the endpoint from the list', async () => {
    await deleteEndpoint(page, id);
  });
}
