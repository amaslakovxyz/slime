import Link from 'next/link';
import { LivePoller } from '@/app/ui/live-poller';
import { crystalTokenHints } from '@/lib/crystal-tokens';
import { isCloud } from '@/lib/env';
import { DEFAULT_THRESHOLDS, readLifecycle, stagesOf, tierStats, toRow, transitionsOf } from '@/lib/lifecycle';
import { loadEndpoint } from '../data';
import { AgentSnippet } from './agent-snippet';
import { LifecycleBoard } from './board';
import { LifecycleDiagram } from './diagram';

// One endpoint is a dispatch buffer: every request lands here, each distinct
// request becomes a handler, and the operator picks which proven ones become
// their own endpoints (Crystal).
export default async function LifecyclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ep } = await loadEndpoint(id);
  const [data, tokenHints] = await Promise.all([readLifecycle(ep), crystalTokenHints(ep.endpointId)]);
  const cloud = isCloud();
  const handlers = data.ok ? data.handlers : [];
  const total = data.ok ? data.total : 0;
  const thresholds = data.ok ? data.thresholds : DEFAULT_THRESHOLDS;
  const stages = stagesOf(ep.status, handlers, total, thresholds);
  const transitions = transitionsOf(handlers, total, thresholds);
  const events = data.ok ? data.events : [];
  const stats = { gas: tierStats(events, 'gas'), liquid: tierStats(events, 'liquid'), crystal: tierStats(events, 'crystal') };
  const rows = data.ok ? handlers.map((h) => toRow(h, data.thresholds)) : [];
  // The total counts every request the endpoint answered; "since" is only true while the feed still lists them all.
  const firstAt = data.ok && data.events.length && data.events.length >= data.total ? data.events[data.events.length - 1]?.at : undefined;

  return (
    <>
      <LivePoller />

      {data.ok &&
        data.warnings.map((w, i) => (
          <div key={i} className="note" role="status">
            <strong>Warning</strong> <span className="muted small">{w}</span>
          </div>
        ))}

      {!data.ok && (
        // A failure reads as an error (plasma), not as the green "waiting" note.
        <div className={ep.status === 'failed' ? 'alert alert-block' : 'note'} role="status">
          <div>
            <strong>{data.reason}</strong>
            {ep.status === 'failed' && (
              <span className="muted small">
                {' '}
                Fix the connection or provider in <Link href={`/endpoints/${ep.endpointId}/settings`}>Settings</Link>;
                {cloud ? ' saving checks it again.' : ' saving restarts it.'}
              </span>
            )}
          </div>
        </div>
      )}

      <LifecycleDiagram
        stages={stages}
        transitions={transitions}
        rows={rows}
        stats={stats}
        recent={events.length}
        cloud={cloud}
      />

      <section className="card lc-card">
        <h2 className="lc-h"><span className="lc-num">1</span>Connect your agent</h2>
        {ep.url ? (
          <AgentSnippet endpointId={ep.endpointId} url={ep.url} tokenHint={ep.tokenHint} />
        ) : (
          <p className="muted small">{ep.status === 'failed' ? 'Not running.' : 'Starting…'}</p>
        )}
        <div className={`lc-wait ${total > 0 ? 'ok' : ''}`}>
          <i aria-hidden="true" />
          <span>
            {total > 0
              ? `${total} request${total === 1 ? '' : 's'}${firstAt ? ` since ${new Date(firstAt).toLocaleTimeString('en-GB')}` : ''}`
              : handlers.length > 0
                ? cloud
                  ? 'No recent requests'
                  : 'Restarted · same URL'
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
          cloud={cloud}
          tokenHints={tokenHints}
        />
      )}
    </>
  );
}
