// Local entry: one endpoint per process, as a plain Node HTTP server on PORT.
// Started by the admin's local runner (platform/admin/scripts/local-runner.ts).
// The endpoint is composed exactly as in the Lambda (endpoint-runtime.ts), from
// this process's env (config.ts) plus:
//   PORT               listen port
//   SLIME_CRYSTAL_DIR  where Crystallize writes modules; read again on restart
// Every route needs x-api-key: the endpoint key, or for POST /v0/e/<key> that
// Crystal's own token (CRYSTAL_TOKENS). POST /v0/reload is a no-op here (the
// runner restarts the process instead), so the admin calls the same routes in
// both modes.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAuthorized } from './auth.js';
import { DirCrystalStore } from './crystal-store.js';
import { endpointRuntime, startupErrorMessage } from './endpoint-runtime.js';

const MAX_BODY_BYTES = 64 * 1024;
/** Same knob and default as the Lambda entry. */
const FLUSH_LIMIT_MS = Number(process.env.SLIME_FLUSH_LIMIT_MS || 5_000);
/** The runner SIGKILLs 3 s after SIGTERM. */
const STOP_SAVE_LIMIT_MS = 2_000;

async function main(): Promise<void> {
  const port = Number(process.env.PORT || 8700);
  const crystalDir = process.env.SLIME_CRYSTAL_DIR;
  const runtime = await endpointRuntime(process.env, crystalDir ? { crystalStore: new DirCrystalStore(crystalDir) } : {});

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!isAuthorized(req.method ?? 'GET', path, header(req, 'x-api-key'), runtime.apiKey, runtime.crystalTokens)) {
        return send(res, Response.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or wrong x-api-key.', retryable: false } }, { status: 401 }));
      }
      if (req.method === 'POST' && path === '/v0/reload') return send(res, new Response(null, { status: 204 }));
      const response = await runtime.app.fetch(await toRequest(req, port));
      // Same as Lambda: finish store writes and usage before answering, so the admin reads current
      // numbers. Capped like Lambda, because flush also waits for a running review (tens of seconds
      // with a real model) and the admin polls with a 3 s timeout; GETs write nothing, so skip them.
      if (req.method !== 'GET') await Promise.race([runtime.flush(), sleep(FLUSH_LIMIT_MS, undefined, { ref: false })]);
      await send(res, response);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) await send(res, Response.json({ error: { code: 'INTERNAL', message: 'Unexpected server error.', retryable: true } }, { status: 500 }));
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({ listening: `http://localhost:${port}/`, crystals: runtime.crystalCount, mode: runtime.slime.stats().mode }));
  });
  server.on('error', (err) => {
    console.error(JSON.stringify({ fatal: startupErrorMessage(err) }));
    process.exit(1);
  });
  // The runner restarts this process for every provider, connector or Crystal change. close()
  // saves the live run counts first, or every restart sets Liquid progress back. Capped below
  // the runner's 3 s SIGKILL.
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await Promise.race([runtime.close(), sleep(STOP_SAVE_LIMIT_MS, undefined, { ref: false })]).catch((err) =>
      console.error(JSON.stringify({ warning: `Could not save live run counts: ${startupErrorMessage(err)}` })),
    );
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function toRequest(req: IncomingMessage, port: number): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) break;
    chunks.push(chunk as Buffer);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  return new Request(`http://localhost:${port}${req.url ?? '/'}`, {
    method: req.method,
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    console.error(JSON.stringify({ fatal: startupErrorMessage(err) }));
    process.exit(1);
  }
}
