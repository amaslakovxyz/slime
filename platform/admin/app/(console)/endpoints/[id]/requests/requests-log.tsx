'use client';

// The Requests log table plus its trace drawer (request trace design T7). A click selects a row and opens
// the non-modal drawer; while it is open ↑/↓ walk to the next/previous row and Esc closes it. Selection is
// the event id (or at+index when the runtime does not id its events) held in React state, so LivePoller's
// router.refresh() every 2 s keeps the open drawer. The drawer's columns collapse (Handler, Cache hide;
// Result shortens) via the wrapper's `trace-log-open` class — no body-level class, scoped to this widget.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtMs, layerName } from './trace-views';
import { TraceDrawer } from './trace-drawer';
import type { RuntimeEvent } from '@/lib/lifecycle';

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB');
const keyOf = (e: RuntimeEvent, i: number) => e.id ?? `${e.at}-${i}`;

function TierCell({ tier }: { tier?: RuntimeEvent['tier'] }) {
  return <span className={`tier-pill ${tier ? `tier-pill-${tier}` : 'tier-pill-none'}`}>{tier ?? '—'}</span>;
}

function ResultCell({ e }: { e: RuntimeEvent }) {
  // With the drawer open only the icon stays (trace-res-text hides): the drawer header says the rest.
  if (e.code) {
    return (
      <span className="trace-res-stop" title={`${e.code}${e.stopAt ? ` · ${layerName(e.stopAt)}` : ''}`}>
        ✕<span className="trace-res-text"> {e.code}{e.stopAt ? <small> · {layerName(e.stopAt)}</small> : null}</span>
      </span>
    );
  }
  return <span className="trace-res-ok" title={String(e.status ?? 200)}>✓<span className="trace-res-text"> {e.status ?? 200}</span></span>;
}

const editableTarget = (el: EventTarget | null) => {
  const node = el as HTMLElement | null;
  const tag = node?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node?.isContentEditable === true;
};

export function RequestsLog({ endpointId, events }: { endpointId: string; events: RuntimeEvent[] }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const selectedIndex = selectedKey === null ? -1 : events.findIndex((e, i) => keyOf(e, i) === selectedKey);
  const liveEvent = selectedIndex >= 0 ? events[selectedIndex] : undefined;
  // Hold the last event we found: on a LivePoller refresh the selected row can page off the top as new
  // requests land, and the drawer should keep what the operator is reading rather than vanish.
  const lastEvent = useRef<RuntimeEvent | undefined>(undefined);
  if (liveEvent) lastEvent.current = liveEvent;
  const selectedEvent = liveEvent ?? lastEvent.current;
  const open = selectedKey !== null && selectedEvent !== undefined;

  const select = useCallback((e: RuntimeEvent, i: number) => setSelectedKey(keyOf(e, i)), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (editableTarget(ev.target)) return;
      if (ev.key === 'Escape') {
        setSelectedKey(null);
        return;
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (events.length === 0) return;
        const down = ev.key === 'ArrowDown';
        // When the selection has paged off, step in from the nearest end.
        const next = selectedIndex < 0 ? (down ? 0 : events.length - 1) : selectedIndex + (down ? 1 : -1);
        if (next < 0 || next >= events.length) return;
        setSelectedKey(keyOf(events[next]!, next));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, events, selectedIndex]);

  return (
    <div className={`trace-log${open ? ' trace-log-open' : ''}`}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="trace-col-time">Time</th>
              <th className="trace-col-handler">Handler</th>
              <th>Intent</th>
              <th className="trace-col-stage">Stage</th>
              <th className="trace-col-cache">Cache</th>
              {/* Beside the drawer the column is only ✓/✕, too narrow for its title (the cells carry a title). */}
              <th className="trace-col-result" aria-label="Result"><span className="trace-res-text">Result</span></th>
              <th className="num trace-col-lat">Latency</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => {
              const k = keyOf(e, i);
              const selected = k === selectedKey;
              return (
                <tr
                  key={k}
                  className={`trace-row${selected ? ' trace-sel' : ''}`}
                  tabIndex={0}
                  aria-selected={selected}
                  onClick={() => select(e, i)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      select(e, i);
                    }
                  }}
                >
                  <td className="mono trace-col-time" suppressHydrationWarning>{time(e.at)}</td>
                  <td className="mono trace-col-handler" title={e.handlerKey}>{e.handlerKey ? `#${e.handlerKey.slice(0, 6)}` : '—'}</td>
                  <td className="trace-intent" title={e.intent}>{e.intent || '—'}</td>
                  <td className="trace-col-stage"><TierCell tier={e.tier} /></td>
                  <td className="trace-col-cache">{e.route === 'crystal' ? 'own route' : e.cache}</td>
                  <td className="trace-col-result"><ResultCell e={e} /></td>
                  <td className="num mono trace-col-lat">{fmtMs(e.ms)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <TraceDrawer event={selectedEvent} endpointId={endpointId} events={events} open={open} onClose={() => setSelectedKey(null)} />
    </div>
  );
}
