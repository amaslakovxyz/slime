// The trace drawer's model: one runtime feed event becomes 12 layer rows, a verdict, a lit route
// through the diagram, and a waterfall of spans (request trace design T5). Pure functions only —
// no I/O, no fetch — so Tasks 6 and 7's drawer views can share them and unit-test against fixtures.
// Never surfaces input values or result rows: only layer names, statuses, notes, timings and counts.
import type { LayerId, RuntimeEvent, Tier, TraceSpan } from './lifecycle';

export const LAYERS: { id: LayerId; name: string; guard: string }[] = [
  { id: 'edge', name: 'Edge', guard: 'API key · body ≤ 16 KB' },
  { id: 'key', name: 'Parse & key', guard: 'intent · input types · output shape → key' },
  { id: 'route', name: 'Route', guard: 'Crystal → cache → in-flight → generate' },
  { id: 'limits', name: 'Generation limits', guard: '≤ 200 / hour · ≤ 2 concurrent' },
  { id: 'generate', name: 'Generate', guard: 'model writes steps + shape · ≤ 1 repair · 25 s' },
  { id: 'lint', name: 'Lint', guard: 'read-only SQL · $n → input · no literals · ≤ 4 steps' },
  { id: 'cost', name: 'Cost check', guard: 'EXPLAIN cost ≤ 1,000,000' },
  { id: 'execute', name: 'Execute', guard: 'read-only DB user · 2 s statement · row cap 1,000' },
  { id: 'shape', name: 'Shape in QuickJS', guard: 'QuickJS · 32 MiB · 200 ms' },
  { id: 'output', name: 'Output check', guard: 'matches output shape · ≤ input.limit' },
  { id: 'cache', name: 'Cache', guard: 'Gas 1 h · 3 runs → Liquid' },
  { id: 'review', name: 'Review', guard: 'background · ≤ 2 reviews' },
];

const LAYER_IDS = new Set<LayerId>(LAYERS.map((l) => l.id));
const isLayerId = (layer: string): layer is LayerId => LAYER_IDS.has(layer as LayerId);

export type RowStatus = 'pass' | 'skip' | 'stop' | 'pending' | 'unreached' | 'unknown';

const ROW_STATUSES = new Set<RowStatus>(['pass', 'skip', 'stop', 'pending']);
const normalizeStatus = (status: string): RowStatus => (ROW_STATUSES.has(status as RowStatus) ? (status as RowStatus) : 'unknown');

export interface TraceRow {
  id: LayerId;
  name: string;
  guard: string;
  status: RowStatus;
  ms?: number;
  note?: string;
  attempts: { attempt: number; status: RowStatus; note?: string }[];
}

/** `null` when the event was recorded before traces existed (an old event). */
export function traceRows(event: RuntimeEvent): TraceRow[] | null {
  if (!event.trace) return null;
  const byLayer = new Map<LayerId, TraceSpan[]>();
  for (const span of event.trace) {
    if (!isLayerId(span.layer)) continue; // a newer runtime may send a layer this admin does not know; drop it
    const spans = byLayer.get(span.layer);
    if (spans) spans.push(span);
    else byLayer.set(span.layer, [span]);
  }
  const stopIndex = event.stopAt ? LAYERS.findIndex((l) => l.id === event.stopAt) : -1;

  return LAYERS.map((layer, index): TraceRow => {
    const spans = byLayer.get(layer.id);
    if (!spans || spans.length === 0) {
      const unreached = stopIndex >= 0 && index > stopIndex;
      return {
        id: layer.id,
        name: layer.name,
        guard: layer.guard,
        status: unreached ? 'unreached' : 'skip',
        attempts: [],
        ...(unreached ? {} : { note: 'not on this route' }),
      };
    }
    const distinctAttempts = new Set(spans.map((s) => s.attempt).filter((a): a is number => a !== undefined));
    const attempts =
      distinctAttempts.size > 1
        ? spans
            .filter((s): s is TraceSpan & { attempt: number } => s.attempt !== undefined)
            .map((s) => ({ attempt: s.attempt, status: normalizeStatus(s.status), ...(s.note ? { note: s.note } : {}) }))
        : [];
    const last = spans[spans.length - 1]!;
    return {
      id: layer.id,
      name: layer.name,
      guard: layer.guard,
      status: normalizeStatus(last.status),
      ...(last.ms !== undefined ? { ms: last.ms } : {}),
      ...(last.note ? { note: last.note } : {}),
      attempts,
    };
  });
}

export function verdictOf(event: RuntimeEvent, rows: TraceRow[] | null): { ok: boolean; passed: number; skipped: number; stopAt?: LayerId; code?: string } {
  const ok = !event.code && (event.status ?? 200) < 400;
  const passed = rows?.filter((r) => r.status === 'pass').length ?? 0;
  const skipped = rows?.filter((r) => r.status === 'skip').length ?? 0;
  return { ok, passed, skipped, ...(event.stopAt ? { stopAt: event.stopAt } : {}), ...(event.code ? { code: event.code } : {}) };
}

export type NodeId = 'app' | 'edge' | 'router' | 'crystal' | 'cache' | 'gen' | 'guard' | 'db' | 'exec' | 'review' | 'shape' | 'out' | 'answer';

const LIT_ORDER: NodeId[] = ['app', 'edge', 'router', 'crystal', 'cache', 'gen', 'guard', 'exec', 'db', 'shape', 'out', 'answer'];

/** The node a stopAt layer corresponds to; cache and review never stop a request. */
const STOP_NODE: Partial<Record<LayerId, NodeId>> = {
  edge: 'edge',
  key: 'router',
  route: 'router',
  limits: 'gen',
  generate: 'gen',
  lint: 'guard',
  cost: 'guard',
  execute: 'exec',
  shape: 'shape',
  output: 'out',
};

export function routeOf(event: RuntimeEvent, rows: TraceRow[]): { lit: NodeId[]; stop?: NodeId; background: NodeId[]; tier?: Tier } {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const statusOf = (id: LayerId) => byId.get(id)?.status;
  const routeRow = byId.get('route');
  const routeNote = routeRow?.note ?? '';
  const generateRow = byId.get('generate');
  const ok = !event.code && (event.status ?? 200) < 400;

  const lit = new Set<NodeId>(['app']);
  if (statusOf('edge') === 'pass') lit.add('edge');
  if (statusOf('key') === 'pass' && statusOf('route') === 'pass') lit.add('router');
  if (event.route === 'crystal' || (routeNote.startsWith('Crystal ') && !routeNote.includes('failed'))) lit.add('crystal');
  if (routeNote.includes('cache hit')) lit.add('cache');
  if (generateRow?.status === 'pass' || (generateRow?.status === 'skip' && generateRow.ms !== undefined)) lit.add('gen');
  if (statusOf('lint') === 'pass' || statusOf('cost') === 'pass') lit.add('guard');
  if (statusOf('execute') === 'pass') {
    lit.add('exec');
    lit.add('db');
  }
  if (statusOf('shape') === 'pass') lit.add('shape');
  if (statusOf('output') === 'pass') lit.add('out');
  if (ok) lit.add('answer');

  const background: NodeId[] = [];
  if (statusOf('review') === 'pending') background.push('review');
  if (event.cache === 'miss') background.push('cache');

  return {
    lit: LIT_ORDER.filter((id) => lit.has(id)),
    ...(event.stopAt && STOP_NODE[event.stopAt] ? { stop: STOP_NODE[event.stopAt] } : {}),
    background,
    ...(event.tier ? { tier: event.tier } : {}),
  };
}

export function waterfallOf(event: RuntimeEvent): { label: string; start: number; ms: number; kind: 'pass' | 'stop' | 'skip' | 'background' }[] {
  const spans = event.trace ?? [];
  const bars: { label: string; start: number; ms: number; kind: 'pass' | 'stop' | 'skip' | 'background' }[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.layer === 'cache' || span.layer === 'review') continue;
    const ms = span.ms ?? 0;
    const kind = span.status === 'stop' ? 'stop' : span.status === 'skip' ? 'skip' : 'pass';
    const label = span.attempt !== undefined ? `${span.layer} · attempt ${span.attempt}` : span.layer;
    bars.push({ label, start: cursor, ms, kind });
    cursor += ms;
  }
  if (spans.some((s) => s.layer === 'review' && s.status === 'pending')) bars.push({ label: 'review (background)', start: cursor, ms: 0, kind: 'background' });
  return bars;
}
