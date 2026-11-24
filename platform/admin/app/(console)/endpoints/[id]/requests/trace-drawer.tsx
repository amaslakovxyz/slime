'use client';

// The request trace drawer: a non-modal panel (request trace design T7) that reads one feed event through
// the Task 5 functions and shows its header, verdict and three tabs. Non-modal (role="complementary", no
// scrim) so the log behind it stays clickable and ↑/↓ walk between requests; RequestsLog owns that keyboard
// and the open/close state. The code behind a cache hit loads lazily, once per handler key, cached here.
import { useEffect, useMemo, useState } from 'react';
import { loadHandlerCode } from '@/app/actions';
import { traceRows, verdictOf } from '@/lib/request-trace';
import type { HandlerCode, RuntimeEvent } from '@/lib/lifecycle';
import { fmtMs, layerName, LayersView, RouteMapView, WaterfallView, type CodeEntry } from './trace-views';

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB');

type Tab = 'layers' | 'map' | 'wf';
const TABS: { id: Tab; label: string }[] = [
  { id: 'layers', label: 'Layers' },
  { id: 'map', label: 'Route map' },
  { id: 'wf', label: 'Waterfall' },
];

function TierPill({ tier }: { tier?: RuntimeEvent['tier'] }) {
  return <span className={`tier-pill ${tier ? `tier-pill-${tier}` : 'tier-pill-none'}`}>{tier ?? '—'}</span>;
}

export function TraceDrawer({
  event,
  endpointId,
  events,
  open,
  onClose,
}: {
  event?: RuntimeEvent;
  endpointId: string;
  events: RuntimeEvent[];
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('layers');
  // Lazily loaded handler code, keyed by handler key, kept across requests and tab switches ("once per key").
  const [codes, setCodes] = useState<Record<string, CodeEntry>>({});

  const eventKey = event ? (event.id ?? event.at) : null;
  // A new request opens on the Layers tab.
  useEffect(() => setTab('layers'), [eventKey]);

  async function showCode(key: string) {
    if (codes[key]) return; // already loading or loaded
    setCodes((c) => ({ ...c, [key]: { status: 'loading' } }));
    const value: HandlerCode | null = await loadHandlerCode(endpointId, key);
    setCodes((c) => ({ ...c, [key]: { status: 'done', value } }));
  }

  // Stable per request, so the route map's edge-drawing effect redraws only on a new request (and on resize),
  // not on unrelated drawer re-renders (tab switch, code load, waterfall scale).
  const rows = useMemo(() => (event ? traceRows(event) : null), [event]);

  return (
    <aside className={`trace-drawer${open ? ' trace-drawer-open' : ''}`} role="complementary" aria-label="Request trace" aria-hidden={!open}>
      {event && (
        <>
          <div className="trace-d-head">
            <div className="trace-d-top">
              <div>
                <div className="muted small mono">
                  {[time(event.at), event.handlerKey ? `handler #${event.handlerKey.slice(0, 6)}` : 'handler —', event.route === 'crystal' ? 'own route' : event.cache ? `cache ${event.cache}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <div className="trace-d-intent">{event.intent || 'Intent not recorded'}</div>
              </div>
              <button type="button" className="trace-icon-btn" onClick={onClose} aria-label="Close trace">Esc ✕</button>
            </div>
            <div className="trace-d-meta">
              <TierPill tier={event.tier} />
              <span className="mono">{fmtMs(event.ms)} total</span>
              {event.inputs && event.inputs.length > 0 && <span className="mono">inputs: {event.inputs.join(', ')}</span>}
            </div>
            {rows && <Verdict event={event} rows={rows} />}
            {rows && (
              <div className="trace-vtabs" role="tablist" aria-label="Trace views">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    id={`trace-tab-${t.id}`}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    aria-controls="trace-tabpanel"
                    className={tab === t.id ? 'on' : undefined}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="trace-d-body" id="trace-tabpanel" role={rows ? 'tabpanel' : undefined} aria-labelledby={rows ? `trace-tab-${tab}` : undefined}>
            {!rows ? (
              <p className="trace-detail muted">Trace not recorded for this request.</p>
            ) : tab === 'layers' ? (
              <LayersView event={event} rows={rows} events={events} codeEntry={codes[event.handlerKey]} onShowCode={() => showCode(event.handlerKey)} />
            ) : tab === 'map' ? (
              <RouteMapView event={event} rows={rows} />
            ) : (
              <WaterfallView event={event} />
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function Verdict({ event, rows }: { event: RuntimeEvent; rows: NonNullable<ReturnType<typeof traceRows>> }) {
  const v = verdictOf(event, rows);
  if (v.ok) {
    return (
      <div className="trace-verdict trace-verdict-ok">
        ✓ Answered · passed <strong>{v.passed}</strong> layers, {v.skipped} not needed on this route
      </div>
    );
  }
  return (
    <div className="trace-verdict trace-verdict-stop">
      ✕ Stopped at <strong>{v.stopAt ? layerName(v.stopAt) : 'the request'}</strong>
      {v.code ? <> — <b>{v.code}</b></> : null} · {v.passed} layers passed before it
    </div>
  );
}
