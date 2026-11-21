import { formatCount, formatMs, formatShare, formatUsd, monthLabel } from '@/app/format';
import { DailyChart } from '@/app/ui/daily-chart';
import { endpointStats } from '@/lib/endpoints';
import { allGasBill, generationCost, tierCost, TIERS } from '@/lib/pricing';
import { loadEndpoint } from '../data';

const TIER_LABEL = { gas: 'Gas', liquid: 'Liquid', crystal: 'Crystal' } as const;

export default async function UsagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ep } = await loadEndpoint(id);
  const u = await endpointStats(ep.endpointId);
  const tierTotal = TIERS.reduce((sum, t) => sum + u.tiers[t].requests, 0);
  const counterfactual = allGasBill({
    gasRequests: u.tiers.gas.requests,
    liquidRequests: u.tiers.liquid.requests,
    crystalRequests: u.tiers.crystal.requests,
    generations: u.generations,
  });

  return (
    <>
      <section className="card">
        <div className="section-head">
          <h2 className="section-title">Daily requests by tier</h2>
          <span className="muted small">UTC days, {monthLabel(u.month)}</span>
        </div>
        <DailyChart id="usage-daily" daily={u.daily} height={300} />
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">By tier</h2>
          <span className="tag tag-estimate">estimate</span>
        </div>
        <div className="card table-card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tier</th>
                  <th className="num">Requests</th>
                  <th className="num">Share</th>
                  <th className="num">Avg latency</th>
                  <th className="num">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {TIERS.map((tier) => (
                  <tr key={tier}>
                    <td>
                      <span className={`tier-pill tier-pill-${tier}`}>{TIER_LABEL[tier]}</span>
                    </td>
                    <td className="num">{formatCount(u.tiers[tier].requests)}</td>
                    <td className="num">{formatShare(u.tiers[tier].requests, tierTotal)}</td>
                    <td className="num">{formatMs(u.tiers[tier].avgMs)}</td>
                    <td className="num">{formatUsd(tierCost(tier, u.tiers[tier].requests))}</td>
                  </tr>
                ))}
                <tr>
                  <td>Generations</td>
                  <td className="num">{formatCount(u.generations)}</td>
                  <td className="num muted">—</td>
                  <td className="num muted">—</td>
                  <td className="num">{formatUsd(generationCost(u.generations))}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{formatCount(tierTotal)}</td>
                  <td />
                  <td />
                  <td className="num">{formatUsd(u.estimatedUsd)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>

      <section className="section stats">
        <div className="card stat">
          <div className="stat-label">LLM tokens</div>
          <div className="stat-value">{formatCount(u.tokens)}</div>
          <div className="stat-note">
            {u.generations > 0
              ? `input + output, ${formatCount(Math.round(u.tokens / u.generations))} per generation`
              : 'no generations yet'}
          </div>
        </div>
        <div className="card stat">
          <div className="stat-label">Liquid handlers</div>
          <div className="stat-value">{u.liquidHandlers === null ? '—' : formatCount(u.liquidHandlers)}</div>
          <div className="stat-note">
            {u.liquidHandlers === null ? 'not reported yet' : 'stored, as loaded by the last seen instance'}
          </div>
        </div>
        <div className="card stat stat-savings">
          <div className="stat-label">Crystallization savings</div>
          <div className="stat-value">{formatUsd(u.savingsUsd)}</div>
          <div className="stat-note">
            {formatUsd(counterfactual)} if every request had stayed Gas, {formatUsd(u.estimatedUsd)} actual
          </div>
        </div>
      </section>
    </>
  );
}
