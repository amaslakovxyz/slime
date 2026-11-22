// The customer's website backend: serves the page and forwards each panel to
// Slime. Keys stay here (the runtime has no CORS and keys must not reach a
// browser); the browser sends a panel id and its input values, nothing else.
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { PANELS } from './panels.mjs';

const PAGE = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const DEFAULT_MULTI_SOURCE_URL = 'http://localhost:3000';

export function createApp({ env = process.env, fetchImpl = fetch, panels = PANELS } = {}) {
  const byId = new Map(panels.map((panel) => [panel.id, panel]));
  const slimeUrl = trimSlash(env.SLIME_URL ?? '');
  // 'off' = no multi-source server (the public site): the Customer 360 panel is not configured.
  const multiUrl = env.MULTI_SOURCE_URL === 'off' ? '' : trimSlash(env.MULTI_SOURCE_URL || DEFAULT_MULTI_SOURCE_URL);

  /** Where a panel's request goes, with its credentials; null when not configured. */
  function routeOf(panel) {
    if (panel.upstream === 'multi') return multiUrl ? { route: 'self-hosted', url: `${multiUrl}/slime`, headers: {}, full: true } : null;
    if (!slimeUrl || !env.SLIME_API_KEY) return null;
    const key = panel.crystal && env[panel.crystal.keyEnv];
    const token = panel.crystal && env[panel.crystal.tokenEnv];
    if (key && token) return { route: 'crystal', url: `${slimeUrl}/v0/e/${encodeURIComponent(key)}`, headers: { 'x-api-key': token }, full: false };
    return { route: 'query', url: `${slimeUrl}/v0/query`, headers: { 'x-api-key': env.SLIME_API_KEY }, full: true };
  }

  return new Hono()
    .get('/', (c) => c.html(PAGE))
    .get('/api/panels', (c) =>
      c.json(panels.map(({ id, title, story, upstream, intent, inputs, output }) => ({ id, title, story, upstream, intent, inputs, output, route: routeOf(byId.get(id))?.route ?? null }))),
    )
    .post('/api/panels/:id', async (c) => {
      const panel = byId.get(c.req.param('id'));
      if (!panel) return fail(c, 404, 'NOT_FOUND', 'No such panel.');
      const { input = {} } = await c.req.json().catch(() => ({}));
      const problem = inputProblem(panel, input);
      if (problem) return fail(c, 400, 'INVALID_REQUEST', problem);
      const target = routeOf(panel);
      if (!target) {
        const hint = panel.upstream === 'multi'
          ? 'Customer 360 runs on a self-hosted Slime (MULTI_SOURCE_URL); on the public site it is shown live at the demo table.'
          : 'Set SLIME_URL and SLIME_API_KEY (see .env.example).';
        return fail(c, 503, 'NOT_CONFIGURED', hint);
      }
      const body = target.full ? { intent: panel.intent, input, output: panel.output } : { input };
      const started = performance.now();
      let response;
      try {
        response = await fetchImpl(target.url, { method: 'POST', headers: { 'content-type': 'application/json', ...target.headers }, body: JSON.stringify(body) });
      } catch {
        return fail(c, 502, 'UPSTREAM_UNREACHABLE', `Slime did not answer at ${new URL(target.url).origin}.`);
      }
      const payload = await response.json().catch(() => ({ error: { code: 'UPSTREAM_BAD_RESPONSE', message: 'Slime answered with something other than JSON.' } }));
      return c.json({ ...payload, route: target.route, roundTripMs: Math.round(performance.now() - started) }, response.status);
    });
}

/** Exactly the panel's input names, each one of its offered values. */
function inputProblem(panel, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object.';
  const unknown = Object.keys(input).filter((name) => !Object.hasOwn(panel.inputs, name));
  if (unknown.length) return `Unknown input: ${unknown.join(', ')}.`;
  for (const [name, { options }] of Object.entries(panel.inputs)) {
    if (!options.includes(input[name])) return `${name} must be one of ${options.join(', ')}.`;
  }
  return null;
}

function fail(c, status, code, message) {
  return c.json({ error: { code, message } }, status);
}

function trimSlash(url) {
  return url.replace(/\/+$/, '');
}
