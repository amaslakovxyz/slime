# slime-kit layers + Slime Cloud MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `sandbox/` into the `@slime-kit/core` and `@slime-kit/server`
packages inside an npm-workspaces monorepo. Then add a minimal Slime Cloud: one
onboarding page, one admin page, and one Slime Server process per customer.

**Architecture:** see [../oss-saas-split-design.md](../oss-saas-split-design.md) §3–§5.

* Core is the current engine, moved without behavior changes.
* Server is the current HTTP entry plus optional API keys.
* The control plane spawns the Server CLI once per tenant, with an explicit
  environment.

**Tech Stack:**

* Node ≥ 22.9, TypeScript run through `tsx` (no build step).
* npm workspaces.
* Hono 4 (`hono/bearer-auth`, `hono/basic-auth`, `hono/html`), `pg`, `node:test`.

## Global Constraints

- Work in a worktree `slime/.worktrees/slime-kit-mvp` on branch `feat/slime-kit-mvp` from `origin/main`. Open a PR; never push `main`.
- **Before Task 1:** the team agrees on when `sandbox/` moves. `origin/feat/crystal` and `feat/database-adapters` edit it (design R1).
- Add no new npm dependencies. Every new import comes from packages already in `sandbox/package.json`.
- `oss/` never imports `platform/` or `@slime-cloud/*`. Task 1 adds a CI check that enforces this.
- Package versions stay `0.1.0` with `"private": true` until go-public (design §6).
- Commit with explicit `git add <paths>`. Pre-commit must pass; never use `--no-verify`.
- Database tests need `npm run db:up`. CI sets `REQUIRE_DB=1`.

---

### Task 1: Workspace skeleton; move `sandbox/` → `oss/packages/core` (no behavior change)

**Files:**
- Move (`git mv`):
  - `sandbox/src` → `oss/packages/core/src`
  - `sandbox/test` → `oss/packages/core/test`
  - `sandbox/offline` → `oss/packages/core/offline`
  - `sandbox/docs` → `oss/packages/core/docs`
  - `sandbox/README.md` → `oss/packages/core/README.md`
  - `sandbox/tsconfig.json` → `oss/packages/core/tsconfig.json`
  - `sandbox/.env.example` → `oss/packages/core/.env.example`
  - `sandbox/package.json` → `oss/packages/core/package.json`
  - `sandbox/docker-compose.yml` → `oss/docker-compose.yml`
  - `sandbox/db` → `oss/db`
- Delete: `sandbox/package-lock.json` (replaced by the root lockfile)
- Create: `package.json` (root)
- Modify: `oss/packages/core/package.json`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: workspace package `@slime-kit/core`; root scripts `db:up`, `db:down`, `typecheck`, `test`.

- [ ] **Step 1: Record the baseline.**
  Run `cd sandbox && npm ci && npm run db:up && REQUIRE_DB=1 npm test`.
  Note the `# pass` count; the expected tally is 52 tests across 5 files.
  Then run `npm run db:down`.

- [ ] **Step 2: Move the files** with the `git mv` list above. Then remove the lockfile: `git rm sandbox/package-lock.json`.

- [ ] **Step 3: Create the root `package.json`:**

```json
{
  "name": "slime",
  "private": true,
  "workspaces": ["oss/packages/*", "platform/*"],
  "scripts": {
    "db:up": "docker compose -f oss/docker-compose.yml up -d --wait",
    "db:down": "docker compose -f oss/docker-compose.yml down -v",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "npm test --workspaces --if-present"
  }
}
```

- [ ] **Step 4: Edit `oss/packages/core/package.json`:**
  - set `"name": "@slime-kit/core"`;
  - add `"exports": { ".": "./src/index.ts", "./package.json": "./package.json" }`;
  - set `"engines": { "node": ">=22.9" }`;
  - delete the `db:up` and `db:down` scripts;
  - leave every other field unchanged, including all dependencies (Task 2 moves the HTTP ones).

- [ ] **Step 5: Update the CI job.** In `.github/workflows/ci.yml`, job `sandbox`:
  - Keep the job id and its name `Sandbox tests`, so required checks stay stable.
  - Remove `defaults.run.working-directory`.
  - Set `cache-dependency-path: package-lock.json`.
  - Change the psql step to `-f oss/db/init.sql`.
  - Add a last step:

```yaml
      - name: OSS never imports platform code
        run: "! git grep -nE '(\\.\\./)+platform/|@slime-cloud/' -- oss/"
```

- [ ] **Step 6: Install and verify.**
  Run `npm install` (creates `package-lock.json`), `npm run db:up`, `npm run typecheck`, then `REQUIRE_DB=1 npm test`.
  Expected: the same `# pass` count as Step 1, and `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json oss .github/workflows/ci.yml   # the sandbox/ moves and the lockfile removal are already staged by git mv / git rm
git status --short sandbox   # must print nothing
git commit -m "chore: npm workspaces; sandbox becomes oss/packages/core (@slime-kit/core)"
```

---

### Task 2: `@slime-kit/server` with optional API keys

**Files:**
- Move: `oss/packages/core/src/index.ts` → `oss/packages/server/src/cli.ts` (`git mv`, then edit)
- Move: `oss/packages/core/.env.example` → `oss/packages/server/.env.example`
- Create:
  - `oss/packages/server/src/app.ts`
  - `oss/packages/server/package.json`
  - `oss/packages/server/tsconfig.json` (a copy of core's)
  - `oss/packages/server/test/app.test.ts`
  - `oss/packages/core/src/index.ts` (the barrel)
- Modify:
  - `oss/packages/core/src/config.ts:1-6` (delete the `.env` loading)
  - `oss/packages/core/package.json` (scripts; move `hono`/`@hono/node-server` out)

**Interfaces:**
- Produces:
  - `createApp(opts: AppOptions): Hono` with `AppOptions = { engine: AppEngine; connector: Pick<Connector,'safetyCheck'>; apiKey?: string; adminKey?: string }`;
  - CLI `@slime-kit/server/cli`, configured by env `PORT`, `HOST` (default `127.0.0.1`), `SLIME_API_KEY`, `SLIME_ADMIN_KEY`, plus all existing core variables;
  - core barrel exports `Engine`, `EngineDeps`, `QueryMeta`, `Tier`, `config`, `Provider`, `SlimeError`, `ErrorCode`, `PostgresConnector`, `Connector`, `SafetyReport`, `SchemaInfo`, `MemoryHandlerStore`, `PostgresHandlerStore`, `HandlerStore`.

- [ ] **Step 1: Write the failing test** `oss/packages/server/test/app.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, type AppEngine } from '../src/app.js';

const engine = {
  query: async () => ({ data: [{ one: 1 }], meta: { handlerId: 'h1', tier: 'gas', cache: 'hit', timingsMs: { total: 1, generate: 0 } } }),
  stats: () => ({ handlers: { gas: 1, liquid: 0, crystal: 0 } }),
  listHandlers: () => [],
  evict: () => false,
} as unknown as AppEngine;
const connector = { safetyCheck: async () => ({ ok: true, user: 'slime_reader', problems: [] }) };
const query = (auth?: string) =>
  ({ method: 'POST', body: JSON.stringify({ intent: 'x', input: {}, output: {} }),
     headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) } });
const get = (auth?: string) => ({ headers: auth ? { authorization: `Bearer ${auth}` } : {} });

test('no keys configured: routes stay open (local dev unchanged)', async () => {
  const app = createApp({ engine, connector });
  assert.equal((await app.request('/v0/query', query())).status, 200);
  assert.equal((await app.request('/v0/handlers', get())).status, 200);
});

test('apiKey guards /v0/query', async () => {
  const app = createApp({ engine, connector, apiKey: 'k1' });
  assert.equal((await app.request('/v0/query', query())).status, 401);
  assert.equal((await app.request('/v0/query', query('wrong'))).status, 401);
  assert.equal((await app.request('/v0/query', query('k1'))).status, 200);
});

test('adminKey guards /healthz and /v0/handlers*, and the api key does not open them', async () => {
  const app = createApp({ engine, connector, apiKey: 'k1', adminKey: 'a1' });
  for (const path of ['/healthz', '/v0/handlers']) {
    assert.equal((await app.request(path, get())).status, 401, path);
    assert.equal((await app.request(path, get('k1'))).status, 401, path);
    assert.equal((await app.request(path, get('a1'))).status, 200, path);
  }
  assert.equal((await app.request('/v0/handlers/h1', { method: 'DELETE', ...get('k1') })).status, 401);
  assert.equal((await app.request('/v0/handlers/h1', { method: 'DELETE', ...get('a1') })).status, 404);
});
```

- [ ] **Step 2: Create `oss/packages/server/package.json`** and install.

```json
{
  "name": "@slime-kit/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Self-hostable Slime HTTP server: POST /v0/query plus admin routes.",
  "exports": { ".": "./src/app.ts", "./cli": "./src/cli.ts", "./package.json": "./package.json" },
  "engines": { "node": ">=22.9" },
  "scripts": {
    "start": "node --env-file-if-exists=.env --import tsx src/cli.ts",
    "dev": "node --env-file-if-exists=.env --import tsx --watch src/cli.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node --import tsx --test 'test/**/*.test.ts'"
  },
  "dependencies": {
    "@slime-kit/core": "*",
    "@hono/node-server": "<version from core>",
    "hono": "<version from core>",
    "tsx": "<version from core>"
  },
  "devDependencies": { "@types/node": "<version from core>", "typescript": "<version from core>" }
}
```

  Copy each `<version from core>` literally from `oss/packages/core/package.json`. `tsx` is a runtime dependency here because the CLI runs from TS source.
  In core's `package.json`:
  - remove `hono`, `@hono/node-server` and the `dev`/`start` scripts;
  - set `"bench": "node --env-file-if-exists=.env --import tsx src/bench.ts"`.

  Then run `npm install`, and `npm test -w @slime-kit/server`. Expected: FAIL, because `../src/app.js` is not found.

- [ ] **Step 3: Write `oss/packages/core/src/index.ts`** (the public API of `@slime-kit/core`):

```ts
export { Engine, type EngineDeps, type QueryMeta, type Tier } from './engine.js';
export { config, type Provider } from './config.js';
export { SlimeError, type ErrorCode } from './errors.js';
export { PostgresConnector } from './connectors/postgres.js';
export type { Connector, SafetyReport, SchemaInfo } from './connectors/types.js';
export { MemoryHandlerStore, PostgresHandlerStore, type HandlerStore } from './store.js';
```

  Delete the `.env` loader at `oss/packages/core/src/config.ts:1-6` (`try { process.loadEnvFile(...) } catch {}` and its comment). From now on, the npm scripts load `.env` with `--env-file-if-exists`. Real environment variables still win, as they do today.

- [ ] **Step 4: Write `oss/packages/server/src/app.ts`.** Routes and logging are moved verbatim from the old `index.ts:14-50`. The HTTPException branch is new: without it, `onError` would turn auth 401s into 500s.

```ts
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { SlimeError, type Connector, type Engine } from '@slime-kit/core';

export type AppEngine = Pick<Engine, 'query' | 'stats' | 'listHandlers' | 'evict'>;

export interface AppOptions {
  engine: AppEngine;
  connector: Pick<Connector, 'safetyCheck'>;
  /** When set, POST /v0/query requires `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** When set, /healthz and /v0/handlers* require `Authorization: Bearer <adminKey>`. */
  adminKey?: string;
}

export function createApp({ engine, connector, apiKey, adminKey }: AppOptions): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof SlimeError) return c.json({ error: err.toJSON() }, err.status as 400);
    console.error(err);
    return c.json({ error: { code: 'INTERNAL', message: 'Unexpected server error.', retryable: true } }, 500);
  });

  if (apiKey) app.use('/v0/query', bearerAuth({ token: apiKey }));
  if (adminKey) {
    const admin = bearerAuth({ token: adminKey });
    app.use('/healthz', admin);
    app.use('/v0/handlers', admin);
    app.use('/v0/handlers/*', admin);
  }

  app.post(
    '/v0/query',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => c.json({ error: { code: 'INVALID_REQUEST', message: 'Body larger than 16 KB.', retryable: false } }, 413),
    }),
    async (c) => {
      const body = await c.req.json().catch(() => {
        throw new SlimeError('INVALID_REQUEST', 'Body must be valid JSON.');
      });
      const { data, meta } = await engine.query(body);
      c.header('Server-Timing', `total;dur=${meta.timingsMs.total}, generate;dur=${meta.timingsMs.generate}`);
      console.log(JSON.stringify({ at: new Date().toISOString(), handler: meta.handlerId, tier: meta.tier, cache: meta.cache, ms: meta.timingsMs }));
      return c.json({ data, meta });
    },
  );

  app.get('/healthz', async (c) => {
    const safety = await connector.safetyCheck();
    return c.json({ ok: safety.ok, database: safety, ...engine.stats() }, safety.ok ? 200 : 503);
  });
  app.get('/v0/handlers', (c) => c.json({ handlers: engine.listHandlers() }));
  app.delete('/v0/handlers/:id', (c) =>
    engine.evict(c.req.param('id')) ? c.json({ evicted: true }) : c.json({ evicted: false }, 404),
  );
  return app;
}
```

- [ ] **Step 5: Rewrite `oss/packages/server/src/cli.ts`** (the moved `index.ts`). Keep its startup log line and its `SIGINT`/`SIGTERM` handler verbatim, and replace the rest with:

```ts
import { serve } from '@hono/node-server';
import { Engine, PostgresConnector, config } from '@slime-kit/core';
import { createApp } from './app.js';

const connector = new PostgresConnector(config.databaseUrl);
const engine = await Engine.create(connector);
const apiKey = process.env.SLIME_API_KEY || undefined;
const adminKey = process.env.SLIME_ADMIN_KEY || undefined;
const app = createApp({ engine, connector, apiKey, adminKey });
const hostname = process.env.HOST || '127.0.0.1';

const server = serve({ fetch: app.fetch, port: config.port, hostname }, (info) => {
  // keep the existing log line, with `http://${hostname}:${info.port}`, and append
  // `  apiKey=${apiKey ? 'on' : 'off'}  adminKey=${adminKey ? 'on' : 'off'}`
});
```

- [ ] **Step 6: Run** `npm test -w @slime-kit/server` (expected: 3 pass), then `npm run typecheck` and `REQUIRE_DB=1 npm test` (core count unchanged).
  Smoke test:
  - run `SLIME_PROVIDER=offline SLIME_API_KEY=k npm start -w @slime-kit/server`;
  - `curl -s -o /dev/null -w '%{http_code}' -X POST 127.0.0.1:3000/v0/query -d '{}'` must print `401`;
  - the same request with `-H 'authorization: Bearer k' -H 'content-type: application/json'` must not print 401.

- [ ] **Step 7: Commit**

```bash
git add oss package-lock.json
git commit -m "feat: @slime-kit/server package with optional API and admin keys"
```

---

### Task 3: Per-tenant handler table in core (`SLIME_META_TABLE`)

**Files:**
- Modify: `oss/packages/core/src/config.ts` (after `metaDatabaseUrl`)
- Modify: `oss/packages/core/src/engine.ts:160`
- Test: `oss/packages/core/test/meta-table.test.ts`

**Interfaces:**
- Produces: `config.metaTable: string` (env `SLIME_META_TABLE`, default `'handlers'`). It must match `/^[a-z_][a-z0-9_]*$/` (`store.ts`, `PostgresHandlerStore` constructor).

- [ ] **Step 1: Write the failing test:**

```ts
// Each Slime Cloud tenant keeps Liquid handlers in its own slime_meta table.
import './setup.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pg from 'pg';
import { config } from '../src/config.js';
import { PostgresConnector } from '../src/connectors/postgres.js';
import { Engine } from '../src/engine.js';
import { DB_URL, META_URL, dbAvailable, withConfig } from './helpers.js';

const hasDb = await dbAvailable();
const TABLE = 'handlers_t_metatest';

async function meta(sql: string) {
  const client = new pg.Client({ connectionString: META_URL });
  await client.connect();
  try { return (await client.query(sql)).rows; } finally { await client.end(); }
}
after(async () => { if (hasDb) await meta(`DROP TABLE IF EXISTS slime_meta.${TABLE}`); });

test('Engine.create without an injected store uses config.metaTable', { skip: !hasDb }, async () => {
  await withConfig({ metaTable: TABLE }, async () => {
    const connector = new PostgresConnector(DB_URL);
    const engine = await Engine.create(connector);
    try {
      assert.equal(engine.stats().store.kind, 'postgres');
      const [row] = await meta(`SELECT to_regclass('slime_meta.${TABLE}')::text AS t`);
      assert.equal(row.t, `slime_meta.${TABLE}`);
    } finally {
      await engine.close();
      await connector.close();
    }
  });
});
```

- [ ] **Step 2: Run** `REQUIRE_DB=1 npm test -w @slime-kit/core`. Expected: FAIL. `typecheck` also fails, because `metaTable` is not on `config`.

- [ ] **Step 3: Implement.** In `config.ts`, add right after `metaDatabaseUrl`:

```ts
  // slime_meta table for Liquid handlers. Slime Cloud gives every tenant its own.
  metaTable: process.env.SLIME_META_TABLE || 'handlers',
```

  In `engine.ts:160`, replace `new PostgresHandlerStore(config.metaDatabaseUrl)` with `new PostgresHandlerStore(config.metaDatabaseUrl, config.metaTable)`.

- [ ] **Step 4: Run** `REQUIRE_DB=1 npm test` and `npm run typecheck`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add oss/packages/core/src/config.ts oss/packages/core/src/engine.ts oss/packages/core/test/meta-table.test.ts
git commit -m "feat(core): SLIME_META_TABLE selects the slime_meta handler table"
```

---

### Task 4: Slime Cloud control plane — tenant registry, supervisor, onboarding and admin pages

**Files (all new, under `platform/control-plane/`):**
- `package.json`, `tsconfig.json` (a copy of core's), `.env.example`
- `src/tenants.ts`, `src/supervisor.ts`, `src/probe.ts`, `src/pages.ts`, `src/app.ts`, `src/main.ts`
- `test/tenants.test.ts`, `test/supervisor.test.ts`, `test/app.test.ts`
- Modify: root `.gitignore`, adding `platform/control-plane/.data/`

**Interfaces:**
- Consumes:
  - `@slime-kit/core`: `PostgresConnector`, `SafetyReport`;
  - `@slime-kit/server/cli`, whose env is described in Task 2;
  - `SLIME_META_TABLE` from Task 3.
- Produces: `npm start -w @slime-cloud/control-plane`, which serves `GET/POST /onboarding` and `GET /admin`.

- [ ] **Step 1: Create `package.json`** and `.env.example`. The example uses the docker-compose dev credentials that `oss/db/init.sql` already creates.

```json
{
  "name": "@slime-cloud/control-plane",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Slime Cloud MVP: onboarding, admin, one Slime Server per tenant.",
  "scripts": {
    "start": "node --env-file-if-exists=.env --import tsx src/main.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node --import tsx --test 'test/**/*.test.ts'"
  },
  "dependencies": {
    "@slime-kit/core": "*",
    "@slime-kit/server": "*",
    "@hono/node-server": "<version from server>",
    "hono": "<version from server>",
    "tsx": "<version from server>"
  },
  "devDependencies": { "@types/node": "<version from server>", "typescript": "<version from server>" }
}
```

```dotenv
# Password for /admin (user "admin"), also used as every tenant's SLIME_ADMIN_KEY.
CLOUD_ADMIN_TOKEN=change-me
# Where tenants keep Liquid handlers (one slime_meta table per tenant).
CLOUD_META_DATABASE_URL=postgres://slime_writer:slime_writer@localhost:54329/slime
# Managed model keys. Tenants without their own key use these. Leave empty to require BYOK.
CLOUD_ANTHROPIC_API_KEY=
CLOUD_GROQ_API_KEY=
CLOUD_PORT=3100
CLOUD_TENANT_BASE_PORT=4100
CLOUD_DATA_FILE=.data/tenants.json
```

  Then run `npm install`.

- [ ] **Step 2: Write `test/tenants.test.ts`** (it fails at first):

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TenantRegistry } from '../src/tenants.js';

test('add persists; a new registry reloads the same tenants; ports increase; file is 0600', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cloud-')), 'tenants.json');
  const r = new TenantRegistry(file, 4100);
  const a = r.add({ name: 'A', databaseUrl: 'postgres://a', provider: 'offline', llmKey: null });
  const b = r.add({ name: 'B', databaseUrl: 'postgres://b', provider: 'claude', llmKey: 'k' });
  assert.deepEqual([a.port, b.port], [4100, 4101]);
  assert.match(a.id, /^t_[0-9a-f]{8}$/);
  assert.notEqual(a.apiKey, b.apiKey);
  assert.deepEqual(new TenantRegistry(file, 4100).list(), [a, b]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
```

- [ ] **Step 3: Write `src/tenants.ts`:**

```ts
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Provider = 'claude' | 'groq' | 'offline';
export interface NewTenant { name: string; databaseUrl: string; provider: Provider; llmKey: string | null }
export interface Tenant extends NewTenant { id: string; port: number; apiKey: string; createdAt: string }

/** MVP registry: one JSON file. It holds DB URLs and keys in plain text, so mode 0600 and local only (design R3). */
export class TenantRegistry {
  private readonly tenants: Tenant[];

  constructor(private readonly file: string, private readonly basePort: number) {
    this.tenants = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Tenant[]) : [];
  }

  list(): Tenant[] {
    return [...this.tenants];
  }

  add(input: NewTenant): Tenant {
    const tenant: Tenant = {
      ...input,
      id: `t_${randomBytes(4).toString('hex')}`,
      port: this.basePort + this.tenants.length,
      apiKey: `sk_${randomBytes(24).toString('hex')}`,
      createdAt: new Date().toISOString(),
    };
    this.tenants.push(tenant);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.tenants, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
    return tenant;
  }
}
```

  Run `npm test -w @slime-cloud/control-plane`. Expected: the tenants test passes.

- [ ] **Step 4: Write `test/supervisor.test.ts`** (it fails at first):

```ts
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { test } from 'node:test';
import { tenantEnv, type PlatformEnv } from '../src/supervisor.js';
import type { Tenant } from '../src/tenants.js';

const tenant: Tenant = {
  id: 't_0000abcd', name: 'A', port: 4100, apiKey: 'sk_a', createdAt: '2026-11-20T00:00:00Z',
  databaseUrl: 'postgres://r@db/a', provider: 'claude', llmKey: null,
};
const platform: PlatformEnv = { metaDatabaseUrl: 'postgres://w@meta/slime', adminKey: 'adm', managedKeys: { claude: 'managed-claude' } };

test('managed key, own table, own API key and port', () => {
  const env = tenantEnv(tenant, platform);
  assert.equal(env.ANTHROPIC_API_KEY, 'managed-claude');
  assert.equal(env.SLIME_META_TABLE, 'handlers_t_0000abcd');
  assert.equal(env.SLIME_API_KEY, 'sk_a');
  assert.equal(env.SLIME_ADMIN_KEY, 'adm');
  assert.equal(env.PORT, '4100');
  assert.equal(env.DATABASE_URL, 'postgres://r@db/a');
});

test('BYOK key wins over the managed key', () => {
  assert.equal(tenantEnv({ ...tenant, llmKey: 'byok' }, platform).ANTHROPIC_API_KEY, 'byok');
});

test('no tenant key and no managed key for the provider throws', () => {
  assert.throws(() => tenantEnv({ ...tenant, provider: 'groq' }, platform), /no groq key/);
});

test('offline tenants get an absolute handlers file and no model key', () => {
  const env = tenantEnv({ ...tenant, provider: 'offline' }, platform);
  assert.ok(isAbsolute(env.SLIME_OFFLINE_FILE) && existsSync(env.SLIME_OFFLINE_FILE));
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('nothing leaks from the parent environment', () => {
  process.env.SLIME_MODEL = 'leak';
  try {
    assert.equal(tenantEnv(tenant, platform).SLIME_MODEL, undefined);
  } finally {
    delete process.env.SLIME_MODEL;
  }
});
```

- [ ] **Step 5: Write `src/supervisor.ts`:**

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tenant } from './tenants.js';

export interface PlatformEnv {
  metaDatabaseUrl: string;
  adminKey: string;
  managedKeys: { claude?: string; groq?: string };
}
export type TenantStatus = 'running' | 'exited' | 'not started';

const SERVER_CLI = fileURLToPath(import.meta.resolve('@slime-kit/server/cli'));
const SERVER_DIR = dirname(dirname(SERVER_CLI));
const OFFLINE_FILE = fileURLToPath(new URL('offline/handlers.json', import.meta.resolve('@slime-kit/core/package.json')));
const KEY_VAR = { claude: 'ANTHROPIC_API_KEY', groq: 'GROQ_API_KEY' } as const;

/** The complete env of one tenant's Server. Only PATH is inherited, so a developer's shell cannot leak keys or settings into a tenant. */
export function tenantEnv(t: Tenant, p: PlatformEnv): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOST: '127.0.0.1',
    PORT: String(t.port),
    DATABASE_URL: t.databaseUrl,
    META_DATABASE_URL: p.metaDatabaseUrl,
    SLIME_META_TABLE: `handlers_${t.id}`,
    SLIME_PROVIDER: t.provider,
    SLIME_API_KEY: t.apiKey,
    SLIME_ADMIN_KEY: p.adminKey,
  };
  if (t.provider === 'offline') {
    env.SLIME_OFFLINE_FILE = OFFLINE_FILE;
  } else {
    const key = t.llmKey ?? p.managedKeys[t.provider];
    if (!key) throw new Error(`no ${t.provider} key: the tenant has none and no managed key is configured`);
    env[KEY_VAR[t.provider]] = key;
  }
  return env;
}

/** One Slime Server child process per tenant: the same CLI a self-hoster runs (silo, design §4). */
export class Supervisor {
  private readonly procs = new Map<string, ChildProcess>();

  constructor(private readonly platform: PlatformEnv) {}

  start(t: Tenant): void {
    const child = spawn(process.execPath, ['--import', 'tsx', SERVER_CLI], {
      cwd: SERVER_DIR,
      env: tenantEnv(t, this.platform),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    this.procs.set(t.id, child);
  }

  status(t: Tenant): TenantStatus {
    const child = this.procs.get(t.id);
    if (!child) return 'not started';
    return child.exitCode === null && child.signalCode === null ? 'running' : 'exited';
  }

  stopAll(): void {
    for (const child of this.procs.values()) child.kill('SIGTERM');
  }
}
```

  Run the tests. Expected: the supervisor tests pass.

- [ ] **Step 6: Write `test/app.test.ts`** (it fails at first):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createControlPlane, type ControlPlaneDeps } from '../src/app.js';
import type { NewTenant, Tenant } from '../src/tenants.js';

function setup(over: Partial<ControlPlaneDeps> = {}) {
  const tenants: Tenant[] = [];
  const started: string[] = [];
  let verified = 0;
  const deps: ControlPlaneDeps = {
    registry: {
      list: () => [...tenants],
      add: (t: NewTenant) => {
        const tenant = { ...t, id: `t_${tenants.length}`, port: 4100 + tenants.length, apiKey: 'sk_test', createdAt: '2026-11-20T00:00:00Z' };
        tenants.push(tenant);
        return tenant;
      },
    },
    supervisor: { start: (t) => void started.push(t.id), status: () => 'running' },
    verifyDb: async () => { verified++; return { ok: true, user: 'slime_reader', problems: [] }; },
    probe: async () => ({ ok: true, handlers: { gas: 1, liquid: 2, crystal: 0 }, generationsLastHour: 3 }),
    adminToken: 'secret',
    managedProviders: ['claude'],
    ...over,
  };
  return { app: createControlPlane(deps), tenants, started, verified: () => verified };
}
const post = (fields: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(fields) });
const basic = (password: string) => ({ headers: { authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` } });
const valid = { name: 'Acme', databaseUrl: 'postgres://r:r@db/acme', provider: 'claude' };

test('onboarding: valid read-only DB → tenant saved, server started, endpoint and key shown', async () => {
  const s = setup();
  const res = await s.app.request('/onboarding', post(valid));
  assert.equal(res.status, 201);
  const body = await res.text();
  assert.match(body, /sk_test/);
  assert.match(body, /http:\/\/127\.0\.0\.1:4100\/v0\/query/);
  assert.equal(s.tenants.length, 1);
  assert.deepEqual(s.started, ['t_0']);
});

test('onboarding: a role that can write is refused; nothing is saved or started', async () => {
  const s = setup({ verifyDb: async () => ({ ok: false, user: 'admin', problems: ['can INSERT into accounts'] }) });
  const res = await s.app.request('/onboarding', post(valid));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /can INSERT into accounts/);
  assert.equal(s.tenants.length, 0);
  assert.equal(s.started.length, 0);
});

test('onboarding: no own key and no managed key → 400 before touching the DB', async () => {
  const s = setup({ managedProviders: [] });
  const res = await s.app.request('/onboarding', post(valid));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /paste your own key/);
  assert.equal(s.verified(), 0);
});

test('onboarding: BYOK works without a managed key', async () => {
  const s = setup({ managedProviders: [] });
  const res = await s.app.request('/onboarding', post({ ...valid, llmKey: 'sk-ant-own' }));
  assert.equal(res.status, 201);
  assert.equal(s.tenants[0].llmKey, 'sk-ant-own');
});

test('admin: requires the admin token', async () => {
  const s = setup();
  assert.equal((await s.app.request('/admin')).status, 401);
  assert.equal((await s.app.request('/admin', basic('wrong'))).status, 401);
});

test('admin: lists tenants with status and tiers; names are HTML-escaped', async () => {
  const s = setup();
  await s.app.request('/onboarding', post({ ...valid, name: '<b>x</b>' }));
  const res = await s.app.request('/admin', basic('secret'));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(body, /running/);
  assert.match(body, /<td>2<\/td>/); // liquid count from the probe
});
```

- [ ] **Step 7: Write `src/probe.ts`, `src/pages.ts` and `src/app.ts`:**

```ts
// src/probe.ts: reads a tenant's /healthz with the admin key.
import type { Tenant } from './tenants.js';

export interface Health {
  ok: boolean;
  handlers: { gas: number; liquid: number; crystal: number };
  generationsLastHour: number;
}

export async function probe(t: Tenant, adminKey: string): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${t.port}/healthz`, {
      headers: { authorization: `Bearer ${adminKey}` },
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok || res.status === 503 ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
}
```

```ts
// src/pages.ts: server-rendered HTML. hono/html escapes every interpolated value.
import { html } from 'hono/html';
import type { Health } from './probe.js';
import type { TenantStatus } from './supervisor.js';
import type { Provider, Tenant } from './tenants.js';

const layout = (title: string, body: unknown) => html`<!doctype html>
<html><head><meta charset="utf-8"><title>${title} · Slime Cloud</title>
<style>body{font:15px system-ui;max-width:880px;margin:40px auto;padding:0 16px}label{display:block;margin:14px 0 4px}input,select{width:100%;padding:6px}button{margin-top:16px;padding:8px 16px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}.err{color:#b00}pre{background:#f4f4f4;padding:8px;overflow:auto}</style>
</head><body>${body}</body></html>`;

export function onboardingPage(managed: Provider[], errors: string[] = []) {
  return layout('Connect your database', html`
<h1>Connect your database</h1>
${errors.length ? html`<ul class="err">${errors.map((e) => html`<li>${e}</li>`)}</ul>` : ''}
<form method="post" action="/onboarding">
  <label>Workspace name</label><input name="name" required maxlength="80">
  <label>Read-only Postgres URL</label><input name="databaseUrl" required placeholder="postgres://reader:…@host:5432/db">
  <label>Model provider</label>
  <select name="provider">
    <option value="claude">Claude${managed.includes('claude') ? ' (managed key available)' : ''}</option>
    <option value="groq">Groq${managed.includes('groq') ? ' (managed key available)' : ''}</option>
    <option value="offline">Offline demo handlers</option>
  </select>
  <label>Your own API key (optional; BYOK)</label><input name="llmKey" type="password" autocomplete="off">
  <button type="submit">Create my Slime</button>
</form>`);
}

export function createdPage(t: Tenant) {
  const endpoint = `http://127.0.0.1:${t.port}/v0/query`;
  return layout('Your Slime is ready', html`
<h1>${t.name} is ready</h1>
<p>Endpoint: <code>${endpoint}</code></p>
<p>API key (shown once): <code>${t.apiKey}</code></p>
<pre>curl -X POST ${endpoint} \\
  -H 'authorization: Bearer ${t.apiKey}' -H 'content-type: application/json' \\
  -d '{"intent":"number of accounts on each plan","input":{},"output":[{"plan":"string","accounts":"integer"}]}'</pre>`);
}

export interface AdminRow { tenant: Tenant; status: TenantStatus; health: Health | null }

export function adminPage(rows: AdminRow[]) {
  return layout('Admin', html`
<h1>Tenants</h1>
<table>
  <tr><th>Name</th><th>Port</th><th>Provider</th><th>Key</th><th>Status</th><th>Gas</th><th>Liquid</th><th>Gen/h</th></tr>
  ${rows.map(({ tenant: t, status, health: h }) => html`<tr>
    <td>${t.name}</td><td>${t.port}</td><td>${t.provider}</td>
    <td>${t.provider === 'offline' ? '—' : t.llmKey ? 'BYOK' : 'managed'}</td>
    <td>${status}${h ? '' : ' (no health)'}</td>
    <td>${h?.handlers.gas ?? '—'}</td><td>${h?.handlers.liquid ?? '—'}</td><td>${h?.generationsLastHour ?? '—'}</td>
  </tr>`)}
</table>`);
}
```

```ts
// src/app.ts
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import type { SafetyReport } from '@slime-kit/core';
import { adminPage, createdPage, onboardingPage } from './pages.js';
import type { Health } from './probe.js';
import type { Supervisor } from './supervisor.js';
import type { Provider, Tenant, TenantRegistry } from './tenants.js';

export interface ControlPlaneDeps {
  registry: Pick<TenantRegistry, 'list' | 'add'>;
  supervisor: Pick<Supervisor, 'start' | 'status'>;
  verifyDb(url: string): Promise<SafetyReport>;
  probe(t: Tenant): Promise<Health | null>;
  adminToken: string;
  managedProviders: Provider[];
}

const PROVIDERS: Provider[] = ['claude', 'groq', 'offline'];

export function createControlPlane(d: ControlPlaneDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => c.redirect('/onboarding'));
  app.get('/onboarding', (c) => c.html(onboardingPage(d.managedProviders)));

  app.post('/onboarding', async (c) => {
    const form = await c.req.parseBody();
    const name = String(form.name ?? '').trim();
    const databaseUrl = String(form.databaseUrl ?? '').trim();
    const provider = String(form.provider ?? '') as Provider;
    const llmKey = String(form.llmKey ?? '').trim() || null;

    const errors: string[] = [];
    if (!name || name.length > 80) errors.push('Name is required (up to 80 characters).');
    if (!/^postgres(ql)?:\/\//.test(databaseUrl)) errors.push('Database URL must start with postgres://.');
    if (!PROVIDERS.includes(provider)) errors.push('Pick a model provider.');
    else if (provider !== 'offline' && !llmKey && !d.managedProviders.includes(provider)) {
      errors.push(`No managed ${provider} key on this platform: paste your own key.`);
    }
    if (errors.length) return c.html(onboardingPage(d.managedProviders, errors), 400);

    const safety = await d.verifyDb(databaseUrl);
    if (!safety.ok) return c.html(onboardingPage(d.managedProviders, safety.problems), 400);

    const tenant = d.registry.add({ name, databaseUrl, provider, llmKey });
    d.supervisor.start(tenant);
    return c.html(createdPage(tenant), 201);
  });

  app.get('/admin', basicAuth({ username: 'admin', password: d.adminToken }), async (c) => {
    const rows = await Promise.all(
      d.registry.list().map(async (tenant) => ({ tenant, status: d.supervisor.status(tenant), health: await d.probe(tenant) })),
    );
    return c.html(adminPage(rows));
  });

  return app;
}
```

  Run the tests. Expected: all control-plane tests pass.

- [ ] **Step 8: Write `src/main.ts`:**

```ts
import { serve } from '@hono/node-server';
import { PostgresConnector, type SafetyReport } from '@slime-kit/core';
import { createControlPlane } from './app.js';
import { probe } from './probe.js';
import { Supervisor } from './supervisor.js';
import { TenantRegistry, type Provider } from './tenants.js';

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required (see .env.example)`);
    process.exit(1);
  }
  return value;
}

const adminToken = need('CLOUD_ADMIN_TOKEN');
const managedKeys = {
  claude: process.env.CLOUD_ANTHROPIC_API_KEY || undefined,
  groq: process.env.CLOUD_GROQ_API_KEY || undefined,
};
const managedProviders = (['claude', 'groq'] as const).filter((p) => managedKeys[p]) as Provider[];
const supervisor = new Supervisor({ metaDatabaseUrl: need('CLOUD_META_DATABASE_URL'), adminKey: adminToken, managedKeys });
const registry = new TenantRegistry(process.env.CLOUD_DATA_FILE || '.data/tenants.json', Number(process.env.CLOUD_TENANT_BASE_PORT || 4100));

async function verifyDb(url: string): Promise<SafetyReport> {
  const connector = new PostgresConnector(url);
  try {
    return await connector.safetyCheck();
  } catch (err) {
    return { ok: false, user: '', problems: [`Cannot connect: ${(err as Error).message}`] };
  } finally {
    await connector.close();
  }
}

for (const tenant of registry.list()) supervisor.start(tenant);

const app = createControlPlane({ registry, supervisor, verifyDb, probe: (t) => probe(t, adminToken), adminToken, managedProviders });
const port = Number(process.env.CLOUD_PORT || 3100);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () =>
  console.log(`Slime Cloud on http://127.0.0.1:${port}  /onboarding  /admin  tenants=${registry.list().length}  managed=${managedProviders.join(',') || 'none'}`),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    supervisor.stopAll();
    process.exit(0);
  });
}
```

  Add `platform/control-plane/.data/` to the root `.gitignore`. Run `npm run typecheck` and `npm test`. Expected: all workspaces pass, and the CI boundary grep finds nothing.

- [ ] **Step 9: Commit**

```bash
git add platform .gitignore package-lock.json
git commit -m "feat(cloud): control plane MVP with onboarding, admin and one Slime Server per tenant"
```

---

### Task 5: End-to-end smoke and the repository map

**Files:**
- Modify: `README.md` (repo map: `oss/packages/core`, `oss/packages/server`, `platform/control-plane`; root commands).
- Modify: `oss/packages/core/README.md`. Update these setup commands:
  - `npm run db:up` now runs from the repo root;
  - `.env` now lives in `oss/packages/server/` for the server, and in `oss/packages/core/` for `npm run bench`.

- [ ] **Step 1: Start the stack.**
  Run `npm run db:up`, then `cp platform/control-plane/.env.example platform/control-plane/.env`.
  Start `npm start -w @slime-cloud/control-plane` as a long-lived service.
  Expected log: `Slime Cloud on http://127.0.0.1:3100 … tenants=0`.

- [ ] **Step 2: Onboarding in the browser.** Open `http://127.0.0.1:3100/onboarding`.
  - Submit name `Acme`, URL `postgres://slime_reader:slime_reader@localhost:54329/slime`, provider `offline`.
    Expected: "Acme is ready", with endpoint `:4100` and an `sk_…` key.
  - Submit again with `postgres://slime_writer:slime_writer@localhost:54329/slime`.
    Expected: 400, with the safety problems listed.

- [ ] **Step 3: Tenant API.** Run the page's `curl` command 4 times.
  - Expected: 200 every time, with plan rows. `meta.tier` goes from `gas` to `liquid` by the 4th call (3 successful runs and an approved offline review).
  - Without the `authorization` header the call returns 401.

- [ ] **Step 4: Admin page.**
  - `http://127.0.0.1:3100/admin` without credentials returns 401.
  - With `admin` / `change-me` it shows one row: Acme, 4100, offline, —, running, Liquid 1.

- [ ] **Step 5: Restart.** Stop and start the control plane.
  - Expected log: `tenants=1`.
  - The admin page shows Acme running with Liquid 1, because the tenant's table `slime_meta.handlers_t_…` reloaded on start.
  - The curl from Step 3 returns `liquid` immediately.

- [ ] **Step 6: Clean up and commit.**
  Stop the service, run `npm run db:down`, delete `platform/control-plane/.data/` and `.env`. Then:

```bash
git add README.md oss/packages/core/README.md
git commit -m "docs: repository map and setup for slime-kit packages and the Slime Cloud MVP"
```

---

## Out of scope (design §6)

- Splitting core further (`@slime-kit/postgres`, `@slime-kit/llm`, config injection, `SandboxRunner`, `Telemetry`).
- DynamoDB store; AWS (ECS, NAT EIP, Secrets Manager); `platform/data-plane/`, `platform/infra/`.
- Accounts, login, billing, metering, a dashboard beyond the admin table.
- LICENSE, CLA bot, public mirror, npm publishing.

## Plan review ledger

- **Survived (risk):**
  - The move in Task 1 conflicts with `origin/feat/crystal` and `feat/database-adapters`. This is a gate in Global Constraints.
  - Tenant secrets sit in a plain-text JSON file (design R3). The MVP is local only.
- **Answered:**
  - *"Core still reads env through the `config` singleton, so the layers aren't clean."* Under silo, each tenant is its own process, so per-process env is correct. Config injection is listed as out of scope, not forgotten.
  - *"Auth 401s would become 500s."* Hono's `bearerAuth` throws an `HTTPException`, and the old `onError` turns every non-`SlimeError` into a 500. `createApp` returns `err.getResponse()` first, and Task 2's tests assert 401.
  - *"A developer's `.env` keys would leak into tenants."* `tenantEnv` builds the full environment, inheriting only `PATH`, and a test covers it. `config.ts` no longer loads `.env` itself.
  - *"Do we need a data-plane package?"* No. The control plane spawns the OSS Server CLI, which is exactly what a self-hoster runs.
- **Deferred:** Tenant processes are not restarted when they crash. The admin page shows `exited`; auto-restart comes with ECS.
