'use client';

// Variant B — the endpoint's architecture with this request's path lit (mockup renderMap/drawEdges).
// Driven by routeOf (Task 5): which nodes are lit, the stop node, the background ones and the tier. The
// edges are an SVG overlay measured from the laid-out DOM, so they follow the grid on any width; redrawn
// on resize and whenever the request changes.
import { useLayoutEffect, useRef, useState } from 'react';
import { fmtMs } from './trace-views';
import { routeOf, type NodeId, type TraceRow } from '@/lib/request-trace';
import type { RuntimeEvent } from '@/lib/lifecycle';

const NODES: [NodeId, string, string, string][] = [
  ['app', '1/2', 'Your app / agent', 'POST /v0/query'],
  ['edge', '2/2', 'Edge', 'key · 16 KB'],
  ['router', '3/2', 'Router', 'by handler key'],
  ['crystal', '4/1', 'Crystal', 'frozen · own route'],
  ['cache', '4/2', 'Handler cache', 'Gas · Liquid'],
  ['gen', '4/3', 'Generator', 'limits · LLM · repair'],
  ['guard', '5/3', 'Lint + cost', 'read-only · EXPLAIN'],
  ['db', '6/1', 'Postgres', 'read-only user'],
  ['exec', '6/2', 'Executor', 'steps · 2 s · 1k rows'],
  ['review', '6/3', 'Reviewer', 'background'],
  ['shape', '7/2', 'QuickJS shape', '32 MiB · 200 ms'],
  ['out', '8/2', 'Output check', 'shape · limit'],
  ['answer', '8/3', 'Answer', '200 + meta'],
];
const EDGES: [NodeId, NodeId][] = [
  ['app', 'edge'], ['edge', 'router'], ['router', 'crystal'], ['router', 'cache'], ['router', 'gen'],
  ['gen', 'guard'], ['guard', 'exec'], ['cache', 'exec'], ['crystal', 'exec'], ['exec', 'db'],
  ['exec', 'shape'], ['shape', 'out'], ['out', 'answer'], ['cache', 'review'],
];
/** The layer whose span time labels a node (fixed: the real id is `shape`, not the mockup's `sandbox`). */
const NODE_MS: Partial<Record<NodeId, string>> = { edge: 'edge', router: 'route', gen: 'generate', guard: 'cost', exec: 'execute', shape: 'shape', out: 'output' };

interface PathDef { d: string; stroke: string; width: number; dash: string; opacity: number }

export function RouteMapView({ event, rows }: { event: RuntimeEvent; rows: TraceRow[] }) {
  const route = routeOf(event, rows);
  const tierCls = route.tier ? `trace-t-${route.tier}` : '';
  const mapRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<NodeId, HTMLElement>());
  const [paths, setPaths] = useState<PathDef[]>([]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const r = routeOf(event, rows);
    const on = (id: NodeId) => r.lit.includes(id) || r.stop === id;
    const color = r.tier === 'liquid' ? 'var(--plasma-primary)' : r.tier === 'crystal' ? 'var(--crystal-accent)' : 'var(--gas-accent)';
    const draw = () => {
      const box = map.getBoundingClientRect();
      const centre = (id: NodeId) => {
        const el = nodeRefs.current.get(id);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left - box.left + b.width / 2, y: b.top - box.top + b.height / 2, w: b.width, h: b.height };
      };
      const next: PathDef[] = [];
      for (const [a, b] of EDGES) {
        const A = centre(a);
        const B = centre(b);
        if (!A || !B) continue;
        let stroke = 'var(--border-bright)', dash = '', width = 1.2, opacity = 0.6;
        if (on(a) && on(b)) { stroke = r.stop === b ? 'var(--stop)' : color; width = 2.4; opacity = 1; }
        if (r.background.includes(b) && on(a)) { stroke = 'var(--pending)'; dash = '5 4'; width = 1.6; opacity = 1; }
        if (a === 'out' && b === 'answer' && event.code) opacity = 0.3;
        const dx = B.x - A.x, dy = B.y - A.y;
        let x1: number, y1: number, x2: number, y2: number;
        if (Math.abs(dy) > Math.abs(dx) * 0.4) { x1 = A.x; y1 = A.y + Math.sign(dy) * A.h / 2; x2 = B.x; y2 = B.y - Math.sign(dy) * B.h / 2; }
        else { x1 = A.x + Math.sign(dx) * A.w / 2; y1 = A.y; x2 = B.x - Math.sign(dx) * B.w / 2; y2 = B.y; }
        const my = (y1 + y2) / 2;
        const d = Math.abs(dy) > Math.abs(dx) * 0.4 ? `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}` : `M${x1},${y1} L${x2},${y2}`;
        next.push({ d, stroke, width, dash, opacity });
      }
      setPaths(next);
    };
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [event, rows]);

  return (
    <>
      <div className="trace-map" ref={mapRef}>
        <svg className="trace-edges">
          {paths.map((p, i) => (
            <path key={i} d={p.d} fill="none" stroke={p.stroke} strokeWidth={p.width} strokeDasharray={p.dash} opacity={p.opacity} />
          ))}
        </svg>
        {NODES.map(([id, area, name, sub]) => {
          const [gridRow, gridColumn] = area.split('/');
          const lit = route.lit.includes(id);
          const cls = [lit ? `trace-lit ${tierCls}` : '', route.stop === id ? 'trace-node-stop' : '', route.background.includes(id) ? 'trace-node-bg' : ''].join(' ');
          const msLayer = NODE_MS[id];
          const ms = lit && msLayer ? rows.find((row) => row.id === msLayer)?.ms : undefined;
          return (
            <div key={id} ref={(el) => void (el ? nodeRefs.current.set(id, el) : nodeRefs.current.delete(id))} className={`trace-node ${cls}`} style={{ gridRow, gridColumn }}>
              <span className="trace-node-ms">{ms === undefined ? '' : fmtMs(ms)}</span>
              {name}
              {/* Only nodes on this request's path carry their caption; dim nodes are context, not reading matter. */}
              {lit || route.stop === id ? <small>{sub}</small> : null}
            </div>
          );
        })}
      </div>
      <div className="trace-map-legend">
        <span><i style={{ borderColor: 'var(--gas-accent)' }} />path taken</span>
        <span><i style={{ borderColor: 'var(--stop)' }} />stopped</span>
        <span><i style={{ borderColor: 'var(--pending)', borderTopStyle: 'dashed' }} />background</span>
        <span><i style={{ borderColor: 'var(--border-bright)' }} />not taken</span>
      </div>
    </>
  );
}
