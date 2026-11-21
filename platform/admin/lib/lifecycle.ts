// The Lifecycle tab: one endpoint is a dispatch buffer for every request; each
// distinct request is a handler that moves Gas -> Liquid (automatically, by its
// hash repeating) and Liquid -> Crystal (when the operator picks it). This file
// reads the endpoint's local runtime (server-side, with its token) and derives
// what the tab shows. The derivation is pure and unit-tested.
import type { Endpoint } from './endpoints';
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
  const canCrystallize = h.tier === 'liquid' && h.runs >= t.crystalRuns;
  let progressPct: number;
  let progressLabel: string;
  if (h.tier === 'gas') {
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
    review: reviewOf(h, t),
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

/** Saved records carry the review; live Gas summaries do not, so it is inferred from runs. */
function reviewOf(h: RuntimeHandler, t: Thresholds): HandlerRow['review'] {
  if (h.review === 'approved') return { label: 'approved', tone: 'ok' };
  if (h.review === 'rejected') return { label: 'rejected', tone: 'none' };
  if (h.review === 'pending') return { label: 'reviewing…', tone: 'run' };
  if (h.tier !== 'gas') return { label: h.review === 'none' ? 'no reviewer' : 'approved', tone: 'ok' };
  if (h.runs >= t.liquidRuns) return { label: 'reviewing…', tone: 'run' };
  return { label: '—', tone: 'none' };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function stagesOf(status: Endpoint['status'], handlers: RuntimeHandler[], total: number, t: Thresholds = DEFAULT_THRESHOLDS): Stage[] {
  const ready = status === 'ready' || status === 'updating';
  const linked = handlers.length > 0;
  const liquid = handlers.filter((h) => h.tier !== 'gas').length;
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

export type LifecycleData =
  | { ok: true; handlers: RuntimeHandler[]; events: RuntimeEvent[]; total: number; thresholds: Thresholds }
  | { ok: false; reason: string };

/** Server only: reads the endpoint's runtime with its own token. */
export async function readLifecycle(ep: Endpoint): Promise<LifecycleData> {
  if (!ep.url || (ep.status !== 'ready' && ep.status !== 'updating')) return { ok: false, reason: `Endpoint is ${ep.status}.` };
  const token = await secretStore().get(ep.endpointId, 'SLIME_API_KEY');
  if (!token) return { ok: false, reason: 'Token not found in the secret store.' };
  try {
    const get = (path: string) =>
      fetch(new URL(path, ep.url), { headers: { 'x-api-key': token }, cache: 'no-store', signal: AbortSignal.timeout(3000) });
    const [life, feed] = await Promise.all([get('v0/lifecycle'), get('v0/events')]);
    if (!life.ok || !feed.ok) return { ok: false, reason: `Runtime answered ${life.status}/${feed.status}.` };
    const l = (await life.json()) as { handlers: RuntimeHandler[]; thresholds?: Thresholds };
    const f = (await feed.json()) as { total: number; events: RuntimeEvent[] };
    return { ok: true, handlers: l.handlers, events: f.events, total: f.total, thresholds: l.thresholds ?? DEFAULT_THRESHOLDS };
  } catch {
    if (ep.status === 'updating') return { ok: false, reason: 'Restarting the endpoint to load the new Crystal…' };
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
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Runtime answered ${res.status}.`);
  return ((await res.json()) as { reports: CrystallizeReport[] }).reports;
}
