import Link from 'next/link';
import { formatCount, formatDate, formatUsd } from '@/app/format';
import { TierCards } from '@/app/ui/tier-cards';
import { endpointStats, type Status } from '@/lib/endpoints';
import { loadEndpoint } from './data';

const STATUS_NOTES: Partial<Record<Status, string>> = {
  pending: 'Starting…',
  provisioning: 'Starting…',
  updating: 'Restarting…',
  deleting: 'Deleting…',
};

export default async function EndpointOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ep } = await loadEndpoint(id);
  const stats = await endpointStats(ep.endpointId);
  const note = STATUS_NOTES[ep.status];

  return (
    <>
      {ep.status === 'failed' && (
        <div className="alert alert-block" role="alert">
          <strong>Failed</strong>
          <span className="mono">{ep.error ?? 'No error message recorded.'}</span>
        </div>
      )}
      {note && (
        <div className="note note-live" role="status">
          <i className="pulse" aria-hidden="true" />
          <div>
            <strong>{note}</strong>
          </div>
        </div>
      )}

      <TierCards usage={stats} />

      <section className="section stats" aria-label="This month">
        <div className="card stat">
          <div className="stat-label">Requests</div>
          <div className="stat-value">{formatCount(stats.requests)}</div>
          <div className="stat-note">{formatCount(stats.generations)} generations</div>
        </div>
        <div className="card stat">
          <div className="stat-label">LLM tokens</div>
          <div className="stat-value">{formatCount(stats.tokens)}</div>
        </div>
        <div className="card stat stat-bill">
          <div className="stat-label">Estimated bill</div>
          <div className="stat-value">
            {formatUsd(stats.estimatedUsd)}
          </div>
          <div className="stat-note note-row">
            <span className="tag tag-estimate">estimate</span>
            <Link href={`/endpoints/${ep.endpointId}/usage`}>Usage details</Link>
          </div>
        </div>
        <div className="card stat stat-savings">
          <div className="stat-label">Savings</div>
          <div className="stat-value">{formatUsd(stats.savingsUsd)}</div>
        </div>
      </section>

      <section className="section split">
        <div className="card">
          <h2 className="card-title">Details</h2>
          <dl className="kv">
            <dt>Endpoint ID</dt>
            <dd className="mono">{ep.endpointId}</dd>
            <dt>Provider</dt>
            <dd>{ep.provider}</dd>
            {ep.layerArn && (
              <>
                <dt>Gas layer</dt>
                <dd className="mono">{ep.layerArn.split(':').slice(-2).join(':')}</dd>
              </>
            )}
            <dt>Created</dt>
            <dd>{formatDate(ep.createdAt)}</dd>
            <dt>Updated</dt>
            <dd>{formatDate(ep.updatedAt)}</dd>
          </dl>
        </div>
      </section>
    </>
  );
}
