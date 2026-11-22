'use client';

// Every request that came through the dispatch endpoint, as handlers keyed by
// hash. A proven Liquid row has its own Crystallize button; a Crystal row opens
// its own endpoint (URL, token, curl) right under it. In the cloud the feed is
// the answering Lambda instance's, so it is labelled as such.
import { Fragment, useState, useTransition } from 'react';
import { crystallizeAction, type CrystallizeResult } from '@/app/actions';
import type { HandlerRow, RuntimeEvent } from '@/lib/lifecycle';
import { CLOUD_CRYSTAL_NOTE, CrystalCard } from './crystal-card';

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB');

export function LifecycleBoard({
  endpointId,
  url,
  rows,
  events,
  restarting,
  cloud,
  instance,
  tokenHints,
}: {
  endpointId: string;
  url: string;
  rows: HandlerRow[];
  events: RuntimeEvent[];
  restarting: boolean;
  cloud: boolean;
  instance: boolean;
  tokenHints: Record<string, string>;
}) {
  const [result, setResult] = useState<CrystallizeResult | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const busy = pending || restarting;

  const crystallize = (key: string) => {
    // Outside the transition: state set inside an async transition renders only when it ends,
    // so the button would never say "Crystallizing…".
    setWorking(key);
    startTransition(async () => {
      try {
        setResult(await crystallizeAction(endpointId, [key]));
      } finally {
        setWorking(null);
      }
    });
  };

  return (
    <section className="card lc-card">
      <h2 className="lc-h">
        <span className="lc-num">2</span>Requests
        {restarting && !cloud && <span className="muted small lc-restarting">Restarting…</span>}
      </h2>
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
      {cloud && result && 'reports' in result && result.reports.some((r) => r.outcome === 'crystallized') && (
        <p className="muted small" role="status">{CLOUD_CRYSTAL_NOTE}</p>
      )}
      {rows.length === 0 ? (
        <p className="lc-empty">No requests yet.</p>
      ) : (
        <div className="lc-table-wrap">
          <table className="lc-table">
            <thead>
              <tr><th>Hash</th><th>Intent</th><th>Stage</th><th>Progress</th><th aria-label="Action" /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.key}>
                  <tr className={r.tier === 'crystal' ? 'lc-row-crystal' : undefined}>
                    <td className="mono lc-hash" title={r.key}>#{r.shortKey}</td>
                    <td className="lc-intent">{r.intent}</td>
                    <td><span className={`tier-pill tier-pill-${r.tier}`}>{r.tier}</span></td>
                    <td>
                      <div className="lc-prog">
                        <div className="lc-bar"><i className={`lc-fill-${r.canCrystallize ? 'crystal' : r.tier}`} style={{ width: `${r.progressPct}%` }} /></div>
                        <span className={r.review.tone === 'run' ? 'lc-review-run' : undefined}>{r.review.tone === 'run' ? r.review.label : r.progressLabel}</span>
                      </div>
                    </td>
                    <td className="lc-action">
                      {r.canCrystallize && (
                        <button
                          className="btn btn-sm lc-btn-crystal"
                          type="button"
                          aria-label={`Crystallize ${r.shortKey}`}
                          onClick={() => crystallize(r.key)}
                          disabled={busy}
                        >
                          {working === r.key ? 'Crystallizing…' : 'Crystallize'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {r.tier === 'crystal' && (
                    <tr className="lc-sub">
                      <td colSpan={5}>
                        <CrystalCard
                          endpointId={endpointId}
                          url={url}
                          crystal={r}
                          tokenHint={tokenHints[r.key]}
                          restarting={restarting}
                          cloud={cloud}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {events.length > 0 && instance && <p className="muted small">Recent requests · this instance</p>}
      {events.length > 0 && (
        <div className="lc-feed" aria-label={instance ? 'Recent requests on this instance' : 'Recent requests'}>
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
  );
}
