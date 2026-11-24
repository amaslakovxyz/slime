// Two projects over the same UI:
// - local (`npm run e2e`): CUJs 1-4 against `npm run local` (next dev + the local
//   runner) with DynamoDB Local, the demo Postgres and the Offline provider;
// - cloud (`npm run e2e:cloud`): the Goal 10 smoke against the hosted admin, with
//   SMOKE_EMAIL/SMOKE_PASSWORD (skipped when they are unset).
// Reports land in platform/admin/playwright-report and test-results, where CI uploads them.
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const adminDir = resolve(import.meta.dirname, '..');
/** The cloud smoke must not start a local stack it never uses. */
const cloudOnly = process.argv.some((arg, i, all) => arg === '--project=cloud' || (arg === '--project' && all[i + 1] === 'cloud'));
// E2E_PORT: several checkouts share one machine (README), and reuseExistingServer must never pick up another checkout's admin.
const LOCAL_PORT = Number(process.env.E2E_PORT || 3100);

export default defineConfig({
  testDir: import.meta.dirname,
  outputDir: resolve(adminDir, 'test-results'),
  reporter: [['list'], ['html', { outputFolder: resolve(adminDir, 'playwright-report'), open: 'never' }]],
  // One user journey per spec, each step depending on the last: run them in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  projects: [
    {
      name: 'local',
      testMatch: /local\.spec\.ts$/,
      // Twelve queries, a Crystallize and a runner restart, on a next dev that compiles pages on first visit.
      timeout: 240_000,
      use: { baseURL: `http://localhost:${LOCAL_PORT}` },
    },
    {
      name: 'cloud',
      testMatch: /cloud-smoke\.spec\.ts$/,
      // Create against an unreachable database waits out the admin's 20 s health-check window.
      timeout: 120_000,
      use: { baseURL: process.env.ADMIN_URL || 'https://admin.amaslakov.com' },
    },
  ],
  webServer: cloudOnly
    ? undefined
    : {
        command: 'npm run local',
        cwd: adminDir,
        url: `http://localhost:${LOCAL_PORT}/login`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        // Merged over process.env (and over .env.local, which never overrides the environment).
        // SLIME_CANNED_HANDLERS: the local runtime answers with canned handlers instead of a model (test only).
        env: {
          PORT: String(LOCAL_PORT),
          ADMIN_ALLOWED_EMAILS: 'e2e@example.com',
          // The journeys test the real login, so the local auto-login (.env.local) is off here.
          ADMIN_DEV_USER: '',
          NEXT_TELEMETRY_DISABLED: '1',
          SLIME_CANNED_HANDLERS: resolve(adminDir, '../runtime/test/canned-handlers.json'),
        },
      },
});
