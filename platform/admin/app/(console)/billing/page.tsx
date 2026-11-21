import { formatCount, formatUsd, monthLabel } from '@/app/format';
import { requireUser } from '@/lib/auth';
import { listWithStats, summarize } from '@/lib/endpoints';
import { allGasBill, generationCost, PRICE_PER_GENERATION_USD, TIER_PRICE_PER_1K_USD, tierCost, TIERS } from '@/lib/pricing';

const TIER_ROWS = {
  gas: { label: 'Gas', note: 'Generated on demand, unreviewed, in memory for 1 h' },
  liquid: { label: 'Liquid', note: 'Reviewed and saved, 2-8 ms' },
  crystal: { label: 'Crystal', note: 'Frozen code with its own endpoint, under 2 ms' },
} as const;

export default async function BillingPage() {
  const email = await requireUser();
  const o = summarize(await listWithStats(email));
  const billable = {
    gasRequests: o.tiers.gas.requests,
    liquidRequests: o.tiers.liquid.requests,
    crystalRequests: o.tiers.crystal.requests,
    generations: o.generations,
  };
  const counterfactual = allGasBill(billable);
  const savedShare = counterfactual > 0 ? Math.round((o.savingsUsd / counterfactual) * 100) : 0;

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{monthLabel(o.month)}</div>
          <h1 className="page-title">Billing</h1>
          <p className="page-sub">Estimate only. Nothing is charged.</p>
        </div>
      </header>

      <div className="split">
        <section className="card bill-hero">
          <div className="stat-label">
            This month
          </div>
          <div className="bill-total mono">{formatUsd(o.estimatedUsd)}</div>
          <p className="card-sub">
            {formatCount(o.requests)} request{o.requests === 1 ? '' : 's'} · {formatCount(o.generations)} generation{o.generations === 1 ? '' : 's'}
          </p>
        </section>
        <section className="card savings-card">
          <h2 className="card-title">Savings</h2>
          <div className="savings-value mono">{formatUsd(o.savingsUsd)}</div>
          <p className="card-sub">
            vs. {formatUsd(counterfactual)} all-Gas{savedShare > 0 ? ` · −${savedShare}%` : ''}
          </p>
        </section>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Rate card</h2>
        </div>
        <div className="card table-card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Price</th>
                  <th className="num">This month</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {TIERS.map((tier) => (
                  <tr key={tier}>
                    <td>
                      <span className={`tier-pill tier-pill-${tier}`}>{TIER_ROWS[tier].label}</span>
                    </td>
                    <td className="num">{formatUsd(TIER_PRICE_PER_1K_USD[tier])} / 1k requests</td>
                    <td className="num">{formatCount(o.tiers[tier].requests)}</td>
                    <td className="num">{formatUsd(tierCost(tier, o.tiers[tier].requests))}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    Generation
                  </td>
                  <td className="num">{formatUsd(PRICE_PER_GENERATION_USD)} each</td>
                  <td className="num">{formatCount(o.generations)}</td>
                  <td className="num">{formatUsd(generationCost(o.generations))}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td />
                  <td />
                  <td className="num">{formatUsd(o.estimatedUsd)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>

    </>
  );
}
