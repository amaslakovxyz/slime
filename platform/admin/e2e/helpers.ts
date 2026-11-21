// UI steps both E2E projects share, written against what a user sees (labels,
// buttons, the status badge) rather than component internals.
import { expect, type Page } from '@playwright/test';

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
