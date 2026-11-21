import { formatCount, formatMs, formatShare, formatUsd } from '@/app/format';
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
          <h2 className="section-title">Requests by day</h2>
        </div>
        <DailyChart id="usage-daily" daily={u.daily} height={220} />
      </section>

      <section className="section">
        <div className="card table-card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Stage</th>
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
                  <td>
                    Total <span className="tag tag-estimate">estimate</span>
                  </td>
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

      <p className="section muted small">
        {formatCount(u.tokens)} LLM tokens · {formatUsd(u.savingsUsd)} saved vs. {formatUsd(counterfactual)} all-Gas
      </p>
    </>
  );
}
