// Checks .env before seeding: both tokens work, and the seeder can see the parent page.
//
//   npm run notion:check
const NOTION = 'https://api.notion.com';
const NOTION_VERSION = '2025-09-03';

const checks = [
  ['NOTION_TOKEN (Slime reader)', () => call(required('NOTION_TOKEN'), '/v1/users/me').then((user) => `works, integration "${user.name}"`)],
  ['NOTION_SEED_TOKEN (Slime seeder)', () => call(required('NOTION_SEED_TOKEN'), '/v1/users/me').then((user) => `works, integration "${user.name}"`)],
  ['NOTION_PARENT_PAGE_ID', () => call(required('NOTION_SEED_TOKEN'), `/v1/pages/${pageId(required('NOTION_PARENT_PAGE_ID'))}`).then(() => 'the seeder can open the page')],
  ['NOTION_PARENT_PAGE_ID (reader)', () => call(required('NOTION_TOKEN'), `/v1/pages/${pageId(required('NOTION_PARENT_PAGE_ID'))}`).then(() => 'the reader can open the page')],
];

let isOk = true;
for (const [name, check] of checks) {
  try {
    console.log(`ok    ${name}: ${await check()}`);
  } catch (error) {
    isOk = false;
    console.log(`FAIL  ${name}: ${error.message}`);
  }
}
console.log(isOk ? '\nReady: npm run notion:seed' : '\nFix the lines marked FAIL in .env (see the comments at its top).');
process.exitCode = isOk ? 0 : 1;

async function call(token, path) {
  const response = await fetch(`${NOTION}${path}`, { headers: { authorization: `Bearer ${token}`, 'notion-version': NOTION_VERSION } });
  const body = await response.json();
  if (response.status === 404) throw new Error('not found: share the page with this integration (page menu → Connections)');
  if (response.status === 401) throw new Error('the token is invalid');
  if (!response.ok) throw new Error(`${response.status} ${body.code ?? ''}: ${body.message ?? ''}`);
  return body;
}

// Accepts a bare id, a dashed id, or a whole page URL.
function pageId(value) {
  const hex = value.replace(/-/g, '').match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/i);
  if (!hex) throw new Error(`"${value}" has no 32-character page id`);
  return hex[0];
}

function required(name) {
  if (!process.env[name]) throw new Error(`${name} is empty`);
  return process.env[name];
}
