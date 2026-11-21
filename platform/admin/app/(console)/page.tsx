import Link from 'next/link';
import { formatCompact, formatCount, formatUsd, monthLabel } from '@/app/format';
import { DailyChart } from '@/app/ui/daily-chart';
import { EndpointsTable } from '@/app/ui/endpoints-table';
import { TierCards } from '@/app/ui/tier-cards';
import { requireUser } from '@/lib/auth';
import { listWithStats, summarize } from '@/lib/endpoints';
import { withSpan } from '@/lib/telemetry';

export default async function OverviewPage() {
  const email = await requireUser();
  const rows = await withSpan('dashboard.load', {}, async (span) => {
    const result = await listWithStats(email);
    span.setAttribute('slime.endpoints.count', result.length);
    return result;
  });
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const o = summarize(rows);
  const inFlight = o.byStatus.pending + o.byStatus.provisioning + o.byStatus.updating;

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{monthLabel(o.month)}</div>
          <h1 className="page-title">Overview</h1>
        </div>
        <Link className="btn" href="/endpoints/new">
          New endpoint
        </Link>
      </header>

      <TierCards usage={o} />

      <section className="section stats" aria-label="Totals this month">
        <div className="card stat">
          <div className="stat-label">Endpoints</div>
          <div className="stat-value">{formatCount(o.total)}</div>
          <div className="stat-note status-line">
            <span className="s-ready">{o.byStatus.ready} ready</span>
            <span className="s-pending">{inFlight} in progress</span>
            <span className="s-failed">{o.byStatus.failed} failed</span>
          </div>
        </div>
        <div className="card stat">
          <div className="stat-label">Requests</div>
          <div className="stat-value">{formatCount(o.requests)}</div>
          <div className="stat-note">{formatCount(o.generations)} generations</div>
        </div>
        <div className="card stat">
          <div className="stat-label">LLM tokens</div>
          <div className="stat-value">{formatCompact(o.tokens)}</div>
        </div>
        <div className="card stat stat-bill">
          <div className="stat-label">Estimated bill</div>
          <div className="stat-value">
            {formatUsd(o.estimatedUsd)}
          </div>
          <div className="stat-note note-row">
            <span className="tag tag-estimate">estimate</span>
            <Link href="/billing">Rate card →</Link>
          </div>
        </div>
        <div className="card stat stat-savings">
          <div className="stat-label">Savings</div>
          <div className="stat-value">{formatUsd(o.savingsUsd)}</div>
        </div>
      </section>

      <section className="section card">
        <div className="section-head">
          <h2 className="section-title">Requests by day</h2>
        </div>
        <DailyChart id="overview-daily" daily={o.daily} />
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Endpoints</h2>
          <Link href="/endpoints" className="small">
            All →
          </Link>
        </div>
        {rows.length === 0 ? (
          <div className="card empty">
            <p>No endpoints yet.</p>
            <Link className="btn" href="/endpoints/new">
              Create your first endpoint
            </Link>
          </div>
        ) : (
          <EndpointsTable rows={rows} compact />
        )}
      </section>
    </>
  );
}
