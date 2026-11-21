// Lambda entry: one function serves every endpoint, under /ep/<id>/ on its
// Function URL (platform/infra/platform/runtime.tf).
//
//   /ep/<id>/<route>  id must match ENDPOINT_ID, else 404 before any AWS call;
//                     no settings under /slime/endpoints/<id>/  -> 404 ENDPOINT_NOT_FOUND
//                     wrong or missing x-api-key               -> 401 UNAUTHORIZED
//                     POST /v0/reload                          -> 204, this instance forgets
//                                                                 the endpoint (tenants.ts)
//                     GET /healthz?fresh=1 (endpoint key)      -> reload, then healthz on the
//                                                                 new settings, in one invocation
//                     engine cannot start                      -> 503 NOT_READY with the cause
//                     otherwise the endpoint's own app (app.ts) answers <route>
//   anything else     401, including /healthz: there is no key to check it against
//
// Auth is the local entry's (auth.ts) on the path with /ep/<id> removed: the
// endpoint key opens every route, a Crystal's own token only POST /v0/e/<its key>.
// Lambda freezes the process after the response, so store writes, reviews and
// usage are flushed first, for at most SLIME_FLUSH_LIMIT_MS.
import { setTimeout as sleep } from 'node:timers/promises';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { QuickJSRunner } from '@slime-cloud/core';
import { Hono, type Context } from 'hono';
import { handle, type LambdaContext } from 'hono/aws-lambda';
import { isAuthorized } from './auth.js';
import { S3CrystalStore } from './crystal-store.js';
import { startupErrorMessage, type LogLine } from './endpoint-runtime.js';
import { ENDPOINT_ID, TenantCache, type Tenant } from './tenants.js';

export interface RouterOptions {
  /** How long a response waits for background work; an unfinished review continues when the instance next wakes. */
  flushLimitMs: number;
  log?: (line: LogLine) => void;
}

const EP_PATH = /^\/ep\/([^/]+)(\/.*)?$/;
const DEFAULT_FLUSH_LIMIT_MS = 5_000;
const DEFAULT_TENANT_CACHE_MAX = 8;
const DEFAULT_TENANT_TTL_MS = 30_000;
const DEFAULT_SHARED_SSM_PREFIX = '/slime/shared/';

type Bindings = { lambdaContext?: LambdaContext };

export function createRouter(tenants: Pick<TenantCache, 'get' | 'reload'>, { flushLimitMs, log = (line) => console.log(JSON.stringify(line)) }: RouterOptions): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  // An AWS call that failed (SSM, S3): logged with its cause, answered without it.
  app.onError((err, c) => {
    log({ error: startupErrorMessage(err) });
    return c.json({ error: { code: 'INTERNAL', message: 'Unexpected server error.', retryable: true } }, 500);
  });

  app.all('*', async (c) => {
    const startedAt = performance.now();
    const url = new URL(c.req.url);
    const match = EP_PATH.exec(url.pathname);
    const id = match?.[1] ?? '';
    const route = match ? (match[2] ?? '/') : url.pathname;
    const isEndpoint = ENDPOINT_ID.test(id);
    let status = 500;
    try {
      const response = match ? await serveEndpoint(c, tenants, id, route, url, flushLimitMs, log) : refuse(c, 401, 'UNAUTHORIZED', 'Missing or wrong x-api-key.');
      status = response.status;
      return response;
    } finally {
      log({
        ...(isEndpoint ? { endpointId: id } : {}),
        requestId: c.env?.lambdaContext?.awsRequestId,
        route,
        status,
        ms: Math.round(performance.now() - startedAt),
      });
    }
  });

  return app;
}

async function serveEndpoint(
  c: Context<{ Bindings: Bindings }>,
  tenants: Pick<TenantCache, 'get' | 'reload'>,
  id: string,
  route: string,
  url: URL,
  flushLimitMs: number,
  log: (line: LogLine) => void,
): Promise<Response> {
  let tenant: Tenant | undefined = ENDPOINT_ID.test(id) ? await tenants.get(id) : undefined;
  if (!tenant) return refuse(c, 404, 'ENDPOINT_NOT_FOUND', 'No endpoint with this id.');
  const method = c.req.method;
  if (!isAuthorized(method, route, c.req.header('x-api-key'), tenant.apiKey, tenant.crystalTokens)) {
    return refuse(c, 401, 'UNAUTHORIZED', 'Missing or wrong x-api-key.');
  }
  if (method === 'POST' && route === '/v0/reload') {
    await tenants.reload(id);
    return c.body(null, 204);
  }
  // The admin's check after a settings change: a separate reload could land on another
  // instance, which would then answer from settings up to one TTL old.
  if (route === '/healthz' && url.searchParams.get('fresh') === '1') {
    await tenants.reload(id);
    const fresh = await tenants.get(id);
    if (!fresh) return refuse(c, 404, 'ENDPOINT_NOT_FOUND', 'No endpoint with this id.');
    tenant = fresh;
  }
  let runtime;
  try {
    runtime = await tenant.runtime();
  } catch (err) {
    return refuse(c, 503, 'NOT_READY', `Endpoint is not ready: ${startupErrorMessage(err)}`, true);
  }
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const forwarded = new Request(new URL(`${route}${url.search}`, url.origin), {
    method,
    headers: c.req.raw.headers,
    ...(hasBody ? { body: await c.req.raw.arrayBuffer() } : {}),
  });
  const response = await runtime.app.fetch(forwarded);
  const flushing = runtime.flush().catch((err: unknown) => log({ endpointId: id, warning: `Flush failed: ${startupErrorMessage(err)}` }));
  await Promise.race([flushing, sleep(flushLimitMs, undefined, { ref: false })]);
  return response;
}

function refuse(c: Context, status: 401 | 404 | 503, code: string, message: string, retryable = false): Response {
  return c.json({ error: { code, message, retryable } }, status);
}

/** The deployed router: settings from SSM, Crystals from S3, one QuickJS pool for every endpoint. */
function tenantsFromEnv(env: NodeJS.ProcessEnv): TenantCache {
  return new TenantCache({
    ssm: new SSMClient({}),
    crystals: new S3CrystalStore({ bucket: env.SLIME_CRYSTAL_BUCKET ?? '', client: new S3Client({}) }),
    baseEnv: { ...env },
    sharedPrefix: env.SLIME_SHARED_SSM_PREFIX || DEFAULT_SHARED_SSM_PREFIX,
    maxEntries: Number(env.SLIME_TENANT_CACHE_MAX || DEFAULT_TENANT_CACHE_MAX),
    ttlMs: Number(env.SLIME_TENANT_TTL_MS || DEFAULT_TENANT_TTL_MS),
    runner: new QuickJSRunner(),
  });
}

export const app = createRouter(tenantsFromEnv(process.env), { flushLimitMs: Number(process.env.SLIME_FLUSH_LIMIT_MS || DEFAULT_FLUSH_LIMIT_MS) });
export const handler = handle(app);
