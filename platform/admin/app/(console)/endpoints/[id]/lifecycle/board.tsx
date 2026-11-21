'use client';

// Cards 2 and 3: every request that came through the dispatch endpoint, as
// handlers keyed by hash, and the Crystallize step. Selection lives here so a
// checkbox in the table drives the button below it.
import { useState, useTransition } from 'react';
import { crystallizeAction, type CrystallizeResult } from '@/app/actions';
import type { HandlerRow, RuntimeEvent, Thresholds } from '@/lib/lifecycle';
import { CrystalCard } from './crystal-card';

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB');

export function LifecycleBoard({
  endpointId,
  url,
  rows,
  events,
  thresholds,
  restarting,
  tokenHints,
}: {
  endpointId: string;
  url: string;
  rows: HandlerRow[];
  events: RuntimeEvent[];
  thresholds: Thresholds;
  restarting: boolean;
  tokenHints: Record<string, string>;
}) {
  const [unpicked, setUnpicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CrystallizeResult | null>(null);
  const [pending, startTransition] = useTransition();
  const ready = rows.filter((r) => r.canCrystallize);
  const picked = ready.filter((r) => !unpicked.has(r.key));
  const crystals = rows.filter((r) => r.tier === 'crystal');

  const toggle = (key: string) =>
    setUnpicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const crystallize = () =>
    startTransition(async () => {
      setResult(await crystallizeAction(endpointId, picked.map((r) => r.key)));
    });

  return (
    <>
      <section className="card lc-card">
        <h2 className="lc-h"><span className="lc-num">2</span>Requests</h2>
        {rows.length === 0 ? (
          <p className="lc-empty">No requests yet.</p>
        ) : (
          <table className="lc-table">
            <thead>
              <tr><th aria-label="Pick" /><th>Hash</th><th>Intent</th><th>Stage</th><th>Progress</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    {r.canCrystallize && (
                      <input
                        type="checkbox"
                        className="lc-chk"
                        aria-label={`Pick ${r.shortKey}`}
                        checked={!unpicked.has(r.key)}
                        disabled={pending}
                        onChange={() => toggle(r.key)}
                      />
                    )}
                  </td>
                  <td className="mono lc-hash" title={r.key}>#{r.shortKey}</td>
                  <td className="lc-intent">{r.intent}</td>
                  <td><span className={`tier-pill tier-pill-${r.tier}`}>{r.tier}</span></td>
                  <td>
                    <div className="lc-prog">
                      <div className="lc-bar"><i className={`lc-fill-${r.canCrystallize ? 'crystal' : r.tier}`} style={{ width: `${r.progressPct}%` }} /></div>
                      <span className={r.review.tone === 'run' ? 'lc-review-run' : undefined}>{r.review.tone === 'run' ? r.review.label : r.progressLabel}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {events.length > 0 && (
          <div className="lc-feed" aria-label="Recent requests">
            {events.slice(0, 6).map((e, i) => (
              <div key={`${e.at}-${i}`}>
                <span>{time(e.at)}</span>
                <span>#{e.handlerKey.slice(0, 6)}</span>
                <span className={`lc-${e.tier}`}>{e.tier}</span>
                <span>{e.route === 'crystal' ? 'own route' : e.cache}</span>
                <span className="lc-ms">{e.ms.toFixed(1)} ms</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card lc-card lc-crys">
        <h2 className="lc-h"><span className="lc-num">3</span>Crystallize</h2>
        <div className="lc-crys-row">
          <span className="muted small">{ready.length ? `${ready.length} ready` : `Needs ${thresholds.crystalRuns}+ runs`}</span>
          {(ready.length > 0 || pending || restarting) && (
            <button className="btn lc-btn-crystal" type="button" onClick={crystallize} disabled={pending || restarting || picked.length === 0}>
              {pending ? 'Crystallizing…' : restarting ? 'Restarting…' : `Crystallize ${picked.length}`}
            </button>
          )}
        </div>
        {result && 'error' in result && <p className="alert">{result.error}</p>}
        {result && 'reports' in result && (
          <ul className="lc-reports">
            {result.reports.map((r) => (
              <li key={r.key} className={r.outcome === 'crystallized' ? 'ok' : 'bad'}>
                <span className="mono">#{r.key.slice(0, 6)}</span> {r.outcome}
                {r.reasons.length > 0 && <span className="muted"> — {r.reasons.join('; ')}</span>}
              </li>
            ))}
          </ul>
        )}
        {crystals.length > 0 && (
          <div className="lc-routes">
            {crystals.map((c) => (
              <CrystalCard key={c.key} endpointId={endpointId} url={url} crystal={c} tokenHint={tokenHints[c.key]} restarting={restarting} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
