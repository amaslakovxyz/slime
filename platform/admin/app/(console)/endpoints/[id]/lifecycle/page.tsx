import { LivePoller } from '@/app/ui/live-poller';
import { crystalTokenHints } from '@/lib/crystal-tokens';
import { readLifecycle, stagesOf, toRow } from '@/lib/lifecycle';
import { loadEndpoint } from '../data';
import { AgentSnippet } from './agent-snippet';
import { LifecycleBoard } from './board';

// One endpoint is a dispatch buffer: every request lands here, each distinct
// request becomes a handler, and the operator picks which proven ones become
// their own endpoints (Crystal).
export default async function LifecyclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ep } = await loadEndpoint(id);
  const [data, tokenHints] = await Promise.all([readLifecycle(ep), crystalTokenHints(ep.endpointId)]);
  const handlers = data.ok ? data.handlers : [];
  const total = data.ok ? data.total : 0;
  const stages = stagesOf(ep.status, handlers, total, data.ok ? data.thresholds : undefined);
  const rows = data.ok ? handlers.map((h) => toRow(h, data.thresholds)) : [];
  const firstAt = data.ok && data.events.length ? data.events[data.events.length - 1]?.at : undefined;

  return (
    <>
      <LivePoller />
      <ol className="lc-rail" aria-label="Stages">
        {stages.map((s, i) => (
          <li key={s.id} className={`lc-stage lc-${s.state} lc-s-${s.id}`}>
            <span className="lc-dot">{s.state === 'done' ? '✓' : i + 1}</span>
            <b>{s.label}</b>
          </li>
        ))}
      </ol>

      {data.ok &&
        data.warnings.map((w, i) => (
          <div key={i} className="note" role="status">
            <strong>Warning</strong> <span className="muted small">{w}</span>
          </div>
        ))}

      {!data.ok && (
        <div className="note" role="status">
          <div>
            <strong>{data.reason}</strong>

          </div>
        </div>
      )}

      <section className="card lc-card">
        <h2 className="lc-h"><span className="lc-num">1</span>Connect your agent</h2>
        {ep.url ? (
          <AgentSnippet endpointId={ep.endpointId} url={ep.url} tokenHint={ep.tokenHint} />
        ) : (
          <p className="muted small">Starting…</p>
        )}
        <div className={`lc-wait ${total > 0 ? 'ok' : ''}`}>
          <i aria-hidden="true" />
          <span>
            {total > 0
              ? `${total} request${total === 1 ? '' : 's'}${firstAt ? ` since ${new Date(firstAt).toLocaleTimeString('en-GB')}` : ''}`
              : handlers.length > 0
                ? 'Restarted · same URL'
                : 'Waiting for requests…'}
          </span>
        </div>
      </section>

      {data.ok && ep.url && (
        <LifecycleBoard
          endpointId={ep.endpointId}
          url={ep.url}
          rows={rows}
          events={data.events}
          restarting={ep.status === 'updating'}
          tokenHints={tokenHints}
        />
      )}
    </>
  );
}
