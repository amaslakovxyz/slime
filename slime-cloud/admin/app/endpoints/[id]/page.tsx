import { notFound } from 'next/navigation';
import { deleteEndpointAction } from '@/app/actions';
import { formatCount, formatDate, formatUsd } from '@/app/format';
import { Header } from '@/app/header';
import { requireUser } from '@/lib/auth';
import { endpointStats, getEndpoint } from '@/lib/endpoints';
import { estimateBill } from '@/lib/pricing';
import { TokenReveal } from './token';

const IN_PROGRESS = new Set(['pending', 'provisioning', 'deleting']);

export default async function EndpointPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const email = await requireUser();
  const { id } = await params;
  const { error: actionError } = await searchParams;
  const ep = await getEndpoint(email, id);
  if (!ep) notFound();
  const stats = await endpointStats(ep.endpointId);
  const inProgress = IN_PROGRESS.has(ep.status);
  const deletable = ep.status === 'ready' || ep.status === 'failed';

  return (
    <main className="shell">
      {inProgress && <meta httpEquiv="refresh" content="5" />}
      <Header email={email} />
      <p>
        <a href="/">← Dashboard</a>
      </p>
      {actionError && (
        <div className="alert" role="alert">
          {actionError}
        </div>
      )}

      <section className="card">
        <div className="row" style={{ marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>{ep.name}</h2>
          <span className={`badge badge-${ep.status}`}>{ep.status}</span>
        </div>
        {ep.status === 'failed' && ep.error && <div className="alert">{ep.error}</div>}
        {inProgress && (
          <p className="note">
            Provisioning runs in AWS (slime-provisioner). With DynamoDB Local the status stays pending.
          </p>
        )}
        <dl className="details">
          <dt>Endpoint ID</dt>
          <dd className="mono">{ep.endpointId}</dd>
          <dt>Provider</dt>
          <dd>{ep.provider}</dd>
          <dt>URL</dt>
          <dd className="mono">{ep.url ?? '—'}</dd>
          <dt>Created</dt>
          <dd>{formatDate(ep.createdAt)}</dd>
          <dt>Updated</dt>
          <dd>{formatDate(ep.updatedAt)}</dd>
        </dl>
      </section>

      <section className="section grid" aria-label="Usage this month">
        <div className="card">
          <div className="stat-label">Requests this month</div>
          <div className="stat-value">{formatCount(stats.requests)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Generations this month</div>
          <div className="stat-value">{formatCount(stats.generations)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Liquid handlers</div>
          <div className="stat-value">{formatCount(stats.liquidHandlers)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Estimated bill</div>
          <div className="stat-value">{formatUsd(estimateBill(stats))}</div>
          <div className="stat-note">estimate, this month</div>
        </div>
      </section>

      <section className="section card">
        <h2>Token</h2>
        <TokenReveal endpointId={ep.endpointId} url={ep.url} tokenHint={ep.tokenHint} />
      </section>

      <section className="section card">
        <h2>Delete endpoint</h2>
        <p className="muted">Removes the function, its role, logs, secrets and Liquid handlers. Usage history stays.</p>
        <form action={deleteEndpointAction}>
          <input type="hidden" name="endpointId" value={ep.endpointId} />
          <button className="btn-ghost" type="submit" disabled={!deletable}>
            Delete endpoint
          </button>
        </form>
      </section>
    </main>
  );
}
