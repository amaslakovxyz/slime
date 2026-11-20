import { createEndpointAction } from '@/app/actions';
import { formatCount, formatDate, formatUsd } from '@/app/format';
import { Header } from '@/app/header';
import { requireUser } from '@/lib/auth';
import { listWithStats, PROVIDERS, summarize } from '@/lib/endpoints';
import { withSpan } from '@/lib/telemetry';

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const email = await requireUser();
  const { error } = await searchParams;
  const rows = await withSpan('dashboard.load', {}, async (span) => {
    const result = await listWithStats(email);
    span.setAttribute('slime.endpoints.count', result.length);
    return result;
  });
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const o = summarize(rows);

  const board: Array<{ label: string; value: string; note?: string }> = [
    { label: 'Endpoints', value: formatCount(o.total) },
    { label: 'Ready', value: formatCount(o.byStatus.ready) },
    { label: 'Pending', value: formatCount(o.byStatus.pending + o.byStatus.provisioning) },
    { label: 'Failed', value: formatCount(o.byStatus.failed) },
    { label: 'Requests this month', value: formatCount(o.requests) },
    { label: 'Generations this month', value: formatCount(o.generations) },
    { label: 'Liquid handlers', value: formatCount(o.liquidHandlers) },
    { label: 'Estimated bill', value: formatUsd(o.estimatedUsd), note: 'estimate, this month' },
  ];

  return (
    <main className="shell">
      <Header email={email} />
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      <section className="grid" aria-label="Board">
        {board.map((card) => (
          <div className="card" key={card.label}>
            <div className="stat-label">{card.label}</div>
            <div className="stat-value">{card.value}</div>
            {card.note && <div className="stat-note">{card.note}</div>}
          </div>
        ))}
      </section>

      <section className="section card">
        <h2>Endpoints</h2>
        {rows.length === 0 ? (
          <p className="muted">No endpoints yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>URL</th>
                  <th>Token</th>
                  <th className="num">Requests</th>
                  <th className="num">Generations</th>
                  <th className="num">Liquid handlers</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((ep) => (
                  <tr key={ep.endpointId}>
                    <td>
                      <a href={`/endpoints/${ep.endpointId}`}>{ep.name}</a>
                    </td>
                    <td>
                      <span className={`badge badge-${ep.status}`}>{ep.status}</span>
                    </td>
                    <td className="mono">{ep.url ?? '—'}</td>
                    <td className="mono">slm_…{ep.tokenHint}</td>
                    <td className="num">{formatCount(ep.stats.requests)}</td>
                    <td className="num">{formatCount(ep.stats.generations)}</td>
                    <td className="num">{formatCount(ep.stats.liquidHandlers)}</td>
                    <td className="muted">{formatDate(ep.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section card" style={{ maxWidth: 520 }}>
        <h2>Create endpoint</h2>
        <form action={createEndpointAction} className="stack">
          <label>
            Name
            <input name="name" maxLength={40} required />
          </label>
          <label>
            Provider
            <select name="provider" defaultValue="claude">
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            Postgres URL
            <input name="databaseUrl" type="password" placeholder="postgres://user:pass@host:5432/db" required />
          </label>
          <button className="btn" type="submit">
            Create endpoint
          </button>
        </form>
      </section>
    </main>
  );
}
