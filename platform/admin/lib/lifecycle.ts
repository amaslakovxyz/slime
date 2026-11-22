// The Lifecycle tab: one endpoint is a dispatch buffer for every request; each
// distinct request is a handler that moves Gas -> Liquid (automatically: repeated
// runs, then the review) and Liquid -> Crystal (when the operator picks it). This file
// reads the endpoint's runtime (server-side, with its token): a local process, or the
// endpoint's path on the shared runtime Lambda in the cloud, and derives what the
// tab shows. The derivation is pure and unit-tested.
import type { Endpoint } from './endpoints';
import { isCloud } from './env';
import { secretStore } from './secrets';

export type Tier = 'gas' | 'liquid' | 'crystal';

export interface RuntimeHandler {
  key: string;
  intent: string;
  tier: Tier;
  runs: number;
  review?: string;
  fixtures?: number;
  createdAt?: string;
  /** Crystal only: input names (and types when known) its own route takes. */
  inputs?: Record<string, string | null>;
  /** Saved with another schema, dictionary, prompt or model: regenerates on next request; cannot be crystallized. */
  stale?: boolean;
}

export interface RuntimeEvent {
  at: string;
  handlerKey: string;
  tier: Tier;
  cache: string;
  ms: number;
  route?: 'crystal';
}

export interface Thresholds {
  liquidRuns: number;
  crystalRuns: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { liquidRuns: 3, crystalRuns: 10 };

export interface HandlerRow {
  key: string;
  shortKey: string;
  intent: string;
  tier: Tier;
  runs: number;
  progressPct: number;
  progressLabel: string;
  review: { label: string; tone: 'ok' | 'run' | 'none' };
  canCrystallize: boolean;
  /** Crystal only: an example body for its own route. */
  exampleBody?: string;
}

export type StageState = 'done' | 'now' | 'todo';

export interface Stage {
  id: 'connected' | 'linked' | 'liquid' | 'crystal';
  label: string;
  state: StageState;
  note: string;
}

export const shortKey = (key: string) => key.slice(0, 6);

export function toRow(h: RuntimeHandler, t: Thresholds = DEFAULT_THRESHOLDS): HandlerRow {
  const canCrystallize = h.tier === 'liquid' && !h.stale && h.runs >= t.crystalRuns;
  let progressPct: number;
  let progressLabel: string;
  if (h.stale) {
    progressPct = 0;
    progressLabel = 'stale · regenerates on next request';
  } else if (h.tier === 'gas') {
    progressPct = Math.min(100, (h.runs / t.liquidRuns) * 100);
    progressLabel = `${Math.min(h.runs, t.liquidRuns)}/${t.liquidRuns} to Liquid`;
  } else if (h.tier === 'liquid') {
    progressPct = Math.min(100, (h.runs / t.crystalRuns) * 100);
    progressLabel = canCrystallize ? 'ready to crystallize' : `${h.runs}/${t.crystalRuns} to Crystal`;
  } else {
    progressPct = 100;
    progressLabel = 'own endpoint';
  }
  return {
    key: h.key,
    shortKey: shortKey(h.key),
    intent: h.intent,
    tier: h.tier,
    runs: h.runs,
    progressPct,
    progressLabel,
    review: reviewOf(h),
    canCrystallize,
    ...(h.tier === 'crystal' ? { exampleBody: exampleBody(h.inputs ?? {}) } : {}),
  };
}

const EXAMPLE_VALUES: Record<string, unknown> = { number: 5, string: 'text', boolean: true, list: [] };

/** `{"input":{"limit":5}}` for a Crystal whose route takes `limit` (number). */
export function exampleBody(inputs: Record<string, string | null>): string {
  const input = Object.fromEntries(Object.entries(inputs).map(([name, type]) => [name, type ? EXAMPLE_VALUES[type] ?? null : null]));
  return JSON.stringify({ input });
}

/** The engine's own status: saved records, live summaries and Crystal manifests all carry it. */
function reviewOf(h: RuntimeHandler): HandlerRow['review'] {
  if (h.review === 'approved') return { label: 'approved', tone: 'ok' };
  if (h.review === 'rejected') return { label: 'rejected', tone: 'none' };
  if (h.review === 'pending') return { label: 'reviewing…', tone: 'run' };
  if (h.tier !== 'gas') return { label: h.review === 'none' ? 'no reviewer' : 'approved', tone: 'ok' };
  return { label: '—', tone: 'none' };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function stagesOf(status: Endpoint['status'], handlers: RuntimeHandler[], total: number, t: Thresholds = DEFAULT_THRESHOLDS): Stage[] {
  const ready = status === 'ready' || status === 'updating';
  const linked = handlers.length > 0;
  // A stale saved row is neither Liquid progress nor pickable.
  const liquid = handlers.filter((h) => h.tier !== 'gas' && !h.stale).length;
  const crystal = handlers.filter((h) => h.tier === 'crystal').length;
  const state = (done: boolean, reachable: boolean): StageState => (done ? 'done' : reachable ? 'now' : 'todo');
  return [
    { id: 'connected', label: 'Connected', state: state(ready, true), note: ready ? 'read-only' : status },
    {
      id: 'linked',
      label: 'Agent linked',
      state: state(linked, ready),
      note: linked ? `${plural(handlers.length, 'handler')} · ${plural(total, 'request')}` : 'waiting',
    },
    {
      id: 'liquid',
      label: 'Liquid',
      state: state(liquid > 0, linked),
      note: liquid ? `${liquid} saved` : `after ${t.liquidRuns} runs`,
    },
    {
      id: 'crystal',
      label: 'Crystal',
      state: state(crystal > 0, liquid > 0),
      note: crystal ? plural(crystal, 'own endpoint') : 'pick one',
    },
  ];
}

type LiveLifecycle = {
  ok: true;
  handlers: RuntimeHandler[];
  events: RuntimeEvent[];
  total: number;
  thresholds: Thresholds;
  warnings: string[];
  /** The feed and Gas rows come from the one instance that answered (the shared Lambda), not every instance. */
  instance: boolean;
};
export type LifecycleData = LiveLifecycle | { ok: false; reason: string };

/**
 * Local only: the last answer per endpoint, shown while the runner restarts the runtime process (after
 * a Crystallize or a settings change) and it refuses connections for a moment. Without it a poll that
 * lands in that gap swaps the board for a notice and back, and the board loses its Crystallize report.
 * Per admin process; a fresh one shows the notice.
 */
const lastRead = new Map<string, LiveLifecycle>();

/** Server only: reads the endpoint's runtime with its own token. */
export async function readLifecycle(ep: Endpoint): Promise<LifecycleData> {
  if (ep.status !== 'ready' && ep.status !== 'updating') lastRead.delete(ep.endpointId);
  if (ep.status === 'failed') return { ok: false, reason: ep.error ? `Endpoint failed: ${ep.error}` : 'Endpoint failed.' };
  if (!ep.url || (ep.status !== 'ready' && ep.status !== 'updating')) return { ok: false, reason: `Endpoint is ${ep.status}.` };
  const token = await secretStore().get(ep.endpointId, 'SLIME_API_KEY');
  if (!token) return { ok: false, reason: 'Token not found in the secret store.' };
  const cloud = isCloud();
  try {
    // The shared Lambda may cold-start the endpoint (SSM, S3, the database check) on this call.
    const timeoutMs = cloud ? 8000 : 3000;
    const get = (path: string) =>
      fetch(new URL(path, ep.url), { headers: { 'x-api-key': token }, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    const [life, feed] = await Promise.all([get('v0/lifecycle'), get('v0/events')]);
    if (!life.ok || !feed.ok) return { ok: false, reason: `Runtime answered ${life.status}/${feed.status}.` };
    const l = (await life.json()) as { handlers: RuntimeHandler[]; thresholds?: Thresholds; warnings?: string[]; instance?: boolean };
    const f = (await feed.json()) as { total: number; events: RuntimeEvent[] };
    const data: LiveLifecycle = {
      ok: true,
      handlers: l.handlers,
      events: f.events,
      total: f.total,
      thresholds: l.thresholds ?? DEFAULT_THRESHOLDS,
      warnings: l.warnings ?? [],
      instance: l.instance === true,
    };
    if (!cloud) lastRead.set(ep.endpointId, data);
    return data;
  } catch {
    if (cloud) return { ok: false, reason: 'Endpoint runtime did not answer.' };
    if (ep.status === 'updating') return lastRead.get(ep.endpointId) ?? { ok: false, reason: 'Restarting the endpoint…' };
    lastRead.delete(ep.endpointId);
    return { ok: false, reason: 'Endpoint is not running. Is `npm run local` up?' };
  }
}

export interface CrystallizeReport {
  key: string;
  intent: string;
  outcome: string;
  reasons: string[];
}

/** Server only: asks the runtime to crystallize the chosen handlers. */
export async function crystallizeOn(ep: Endpoint, keys: string[]): Promise<CrystallizeReport[]> {
  const token = await secretStore().get(ep.endpointId, 'SLIME_API_KEY');
  if (!ep.url || !token) throw new Error('Endpoint is not running.');
  const res = await fetch(new URL('v0/crystallize', ep.url), {
    method: 'POST',
    headers: { 'x-api-key': token, 'content-type': 'application/json' },
    body: JSON.stringify({ keys }),
    // Under the 60 s limit of the admin Lambda and CloudFront, so a slow run reports instead of a 504.
    signal: AbortSignal.timeout(55_000),
  });
  if (!res.ok) throw new Error(`Runtime answered ${res.status}.`);
  return ((await res.json()) as { reports: CrystallizeReport[] }).reports;
}

/**
 * Server only: the answering runtime instance drops its cached settings and engine, so its next
 * request reads the new secrets and Crystals; other instances catch up within their TTL (30 s).
 * The local runtime answers 204 and changes nothing (a restart does that job locally).
 */
export async function reloadOn(ep: Endpoint): Promise<void> {
  const token = await secretStore().get(ep.endpointId, 'SLIME_API_KEY');
  if (!ep.url || !token) throw new Error('Endpoint is not running.');
  const res = await fetch(new URL('v0/reload', ep.url), {
    method: 'POST',
    headers: { 'x-api-key': token },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Runtime answered ${res.status} to reload.`);
}
