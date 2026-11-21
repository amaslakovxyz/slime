// CUJs 1-4 on the local stack (`npm run local`, started by the config with
// ADMIN_ALLOWED_EMAILS=e2e@example.com): invite-only sign-up, create -> ready,
// Gas -> Liquid through the dispatch endpoint, Crystallize, the Crystal route with
// its own token, delete. Needs DynamoDB Local with the tables and the demo Postgres.
import { randomBytes } from 'node:crypto';
import { test } from '@playwright/test';
import { expectSignupRefused, lifecycleJourney, PASSWORD, signIn } from './helpers';

const DEMO_DB = 'postgres://slime_reader:slime_reader@localhost:54329/slime';

test('invited developer: sign up, create, Gas -> Liquid -> Crystal, call the Crystal route, delete', async ({ page, request }) => {
  const run = randomBytes(3).toString('hex');

  await test.step('CUJ 1: a non-invited email is refused, the invited one gets in', async () => {
    await expectSignupRefused(page, `other-${run}@example.com`);
    await signIn(page, 'e2e@example.com', PASSWORD);
  });

  await lifecycleJourney(page, request, { name: `e2e-${run}`, databaseUrl: DEMO_DB });
});
