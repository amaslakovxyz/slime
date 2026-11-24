'use client';

// The three drawer tabs (request trace design T1, mockup variants A/B/C). Every view is driven ONLY by
// the Task 5 pure functions (traceRows, routeOf, waterfallOf) — no layer logic is re-derived here. The
// route map lives in its own file (route-map.tsx) so this one stays focused.
import { Fragment, useState } from 'react';
import { LAYERS, type TraceRow } from '@/lib/request-trace';
import type { HandlerCode, RuntimeEvent } from '@/lib/lifecycle';
import { waterfallOf } from '@/lib/request-trace';

export { RouteMapView } from './route-map';

/** 1,234 ms stays legible; a 2 s generation reads as seconds. Matches the mockup's fmtMs. */
export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`);
export const layerName = (id: string) => LAYERS.find((l) => l.id === id)?.name ?? id;

const GLYPH: Record<TraceRow['status'], string> = { pass: '✓', stop: '✕', pending: '◌', skip: '–', unreached: '·', unknown: '?' };

/** A piece of generated code: the SQL, the optional shape, and the model's assumptions. */
function CodeBlock({ code }: { code: Pick<HandlerCode, 'sql' | 'shapeJs' | 'assumptions'> }) {
  return (
    <>
      <pre className="trace-code">{code.sql}</pre>
      {code.shapeJs ? <pre className="trace-code">{code.shapeJs}</pre> : null}
      {code.assumptions.length > 0 && (
        <dl className="trace-kv">
          {code.assumptions.map((a, i) => (
            <div key={i} className="trace-kv-row">
              <dt>assumes</dt>
              <dd>{a}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

export type CodeEntry = { status: 'loading' } | { status: 'done'; value: HandlerCode | null };

/** The code shown under Execute on a cache hit: lazily loaded, with the page's miss event as a fallback. */
function ExecuteCode({ event, events, entry, onShow }: { event: RuntimeEvent; events: RuntimeEvent[]; entry?: CodeEntry; onShow: () => void }) {
  if (!entry) return <button type="button" className="trace-icon-btn" onClick={onShow}>Show code</button>;
  if (entry.status === 'loading') return <p className="trace-detail muted">Loading code…</p>;
  if (entry.value) return <CodeBlock code={entry.value} />;
  // The instance did not have it; another request to the same handler on this page may carry its code.
  const fallback = events.find((e) => e.handlerKey === event.handlerKey && e.generated)?.generated;
  if (fallback) return <CodeBlock code={fallback} />;
  return <p className="trace-detail muted">Code is not available on this instance.</p>;
}

// Variant A — the harness as a checklist the request walked down, with the real default guards (T8).
export function LayersView({
  event,
  rows,
  events,
  codeEntry,
  onShowCode,
}: {
  event: RuntimeEvent;
  rows: TraceRow[];
  events: RuntimeEvent[];
  codeEntry?: CodeEntry;
  onShowCode: () => void;
}) {
  return (
    <>
      <p className="trace-detail muted trace-limits-note">Guard captions are the core default limits.</p>
      <ol className="trace-layers">
        {rows.map((row) => (
          <li key={row.id} className={`trace-layer trace-layer-${row.status}`}>
            <div className="trace-dot">{GLYPH[row.status]}</div>
            <div>
              <div className="trace-l-name">{row.name}</div>
              <div className="trace-l-guard">{row.guard}</div>
              {row.note ? <div className="trace-l-detail">{row.note}</div> : null}
              {row.attempts.length > 0 && (
                <ul className="trace-attempts">
                  {row.attempts.map((a) => (
                    <li key={a.attempt}>
                      <span className="mono">attempt {a.attempt}</span> {GLYPH[a.status]}
                      {a.note ? ` · ${a.note}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {row.id === 'generate' && event.generated && (
                <details className="trace-more" open={row.status === 'stop'}>
                  <summary>Show generated code</summary>
                  <CodeBlock code={event.generated} />
                </details>
              )}
              {row.id === 'execute' && !event.generated && (row.status === 'pass' || row.status === 'stop') && (
                <div className="trace-more">
                  <ExecuteCode event={event} events={events} entry={codeEntry} onShow={onShowCode} />
                </div>
              )}
            </div>
            <div className="trace-l-ms">{row.ms === undefined ? '' : fmtMs(row.ms)}</div>
          </li>
        ))}
      </ol>
    </>
  );
}

// Variant C — a trace waterfall; linear shows where the time really goes, log makes the fast layers readable.
export function WaterfallView({ event }: { event: RuntimeEvent }) {
  const [scale, setScale] = useState<'linear' | 'log'>('linear');
  const bars = waterfallOf(event);
  // An edge stop is a single 0 ms bar — keep the denominator positive so widths stay finite.
  const end = Math.max(...bars.map((b) => b.start + b.ms), 0.1);
  const pos = (v: number) => (scale === 'log' ? (Math.log10(1 + v) / Math.log10(1 + end)) * 100 : (v / end) * 100);
  const tierCls = event.tier === 'liquid' ? 'trace-bar-liquid' : event.tier === 'crystal' ? 'trace-bar-crystal' : '';
  const barClass = (kind: (typeof bars)[number]['kind']) =>
    kind === 'stop' ? 'trace-bar-stop' : kind === 'background' ? 'trace-bar-bg' : kind === 'skip' ? 'trace-bar-skip' : tierCls;
  const ticks = scale === 'log' ? ['0', 'log', fmtMs(end)] : [fmtMs(0), fmtMs(end / 2), fmtMs(end)];

  return (
    <>
      <div className="trace-wf-scale">
        Time scale
        <button type="button" className={scale === 'linear' ? 'on' : undefined} onClick={() => setScale('linear')}>linear</button>
        <button type="button" className={scale === 'log' ? 'on' : undefined} onClick={() => setScale('log')}>log</button>
      </div>
      <div className="trace-wf">
        <div />
        <div className="trace-wf-axis">{ticks.map((t, i) => <span key={i}>{t}</span>)}</div>
        <div />
        {bars.map((b, i) => {
          const left = pos(b.start);
          const width = Math.max(pos(b.start + b.ms) - left, 0.6);
          return (
            <Fragment key={i}>
              <div className="trace-wf-lbl">{b.label}</div>
              <div className="trace-wf-track">
                <div className={`trace-bar ${barClass(b.kind)}`} style={{ left: `${left}%`, width: `${width}%` }} />
              </div>
              <div className="trace-wf-ms">{fmtMs(b.ms)}</div>
            </Fragment>
          );
        })}
      </div>
    </>
  );
}
