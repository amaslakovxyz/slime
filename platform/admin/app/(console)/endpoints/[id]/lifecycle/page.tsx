import { LivePoller } from '@/app/ui/live-poller';
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
  const data = await readLifecycle(ep);
  const handlers = data.ok ? data.handlers : [];
  const total = data.ok ? data.total : 0;
  const stages = stagesOf(ep.status, handlers, total);
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
            <small>{s.note}</small>
          </li>
        ))}
      </ol>

      {!data.ok && (
        <div className="note" role="status">
          <div>
            <strong>{data.reason}</strong>
            <span className="muted small"> The tab reads the endpoint every 2 s.</span>
          </div>
        </div>
      )}

      <section className="card lc-card">
        <h2 className="lc-h"><span className="lc-num">1</span>Give this endpoint to your agent</h2>
        <p className="card-sub">One URL for every request. The agent asks for data in words and the shape it wants; Slime writes the API.</p>
        {ep.url ? (
          <AgentSnippet endpointId={ep.endpointId} url={ep.url} tokenHint={ep.tokenHint} />
        ) : (
          <p className="muted small">The URL appears once the endpoint is ready.</p>
        )}
        <div className={`lc-wait ${total > 0 ? 'ok' : ''}`}>
          <i aria-hidden="true" />
          <span>
            {total > 0
              ? `Agent connected · ${total} requests${firstAt ? ` since ${new Date(firstAt).toLocaleTimeString('en-GB')}` : ''}`
              : handlers.length > 0
                ? 'Endpoint restarted · same URL, counters start over'
                : 'Waiting for the first request from your agent…'}
          </span>
        </div>
      </section>

      {data.ok && ep.url && (
        <LifecycleBoard
          endpointId={ep.endpointId}
          url={ep.url}
          rows={rows}
          events={data.events}
          thresholds={data.thresholds}
          restarting={ep.status === 'updating'}
        />
      )}
    </>
  );
}
