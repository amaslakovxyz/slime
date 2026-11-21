import { formatCount, formatUsd, monthLabel } from '@/app/format';
import { requireUser } from '@/lib/auth';
import { listWithStats, summarize } from '@/lib/endpoints';
import { allGasBill, generationCost, PRICE_PER_GENERATION_USD, TIER_PRICE_PER_1K_USD, tierCost, TIERS } from '@/lib/pricing';

const TIER_ROWS = {
  gas: { label: 'Gas', note: 'Synthesis with the LLM in the loop, 150-400 ms' },
  liquid: { label: 'Liquid', note: 'Stored handlers, 2-8 ms' },
  crystal: { label: 'Crystal', note: 'Compiled hot paths, under 2 ms' },
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
          <p className="page-sub">Usage-based estimate. There is no payment method and nothing is charged.</p>
        </div>
      </header>

      <div className="split">
        <section className="card bill-hero">
          <div className="stat-label">
            Estimated bill this month <span className="tag tag-estimate">estimate</span>
          </div>
          <div className="bill-total mono">{formatUsd(o.estimatedUsd)}</div>
          <p className="card-sub">
            {formatCount(o.requests)} requests and {formatCount(o.generations)} generations across {o.total}{' '}
            {o.total === 1 ? 'endpoint' : 'endpoints'}, month to date (UTC).
          </p>
        </section>
        <section className="card savings-card">
          <h2 className="card-title">Crystallization savings</h2>
          <div className="savings-value mono">{formatUsd(o.savingsUsd)}</div>
          <p className="card-sub">
            Every request is priced by the tier that served it. As intents repeat, Slime digests them from Gas into
            stored Liquid handlers and then compiled Crystal, which cost a fraction per request. Had all{' '}
            {formatCount(o.requests)} requests run as Gas, this month would cost {formatUsd(counterfactual)}
            {savedShare > 0 ? `; crystallization cut that by ${savedShare}%` : ''}.
          </p>
        </section>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Rate card</h2>
          <span className="muted small">Illustrative prices</span>
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
                      <span className="cell-sub cell-sub-sans">{TIER_ROWS[tier].note}</span>
                    </td>
                    <td className="num">{formatUsd(TIER_PRICE_PER_1K_USD[tier])} / 1k requests</td>
                    <td className="num">{formatCount(o.tiers[tier].requests)}</td>
                    <td className="num">{formatUsd(tierCost(tier, o.tiers[tier].requests))}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    Generation
                    <span className="cell-sub cell-sub-sans">One LLM synthesis of a new handler</span>
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

      <section className="section stats">
        <div className="card stat">
          <div className="stat-label">LLM input tokens</div>
          <div className="stat-value">{formatCount(o.inputTokens)}</div>
          <div className="stat-note">Included in the generation price</div>
        </div>
        <div className="card stat">
          <div className="stat-label">LLM output tokens</div>
          <div className="stat-value">{formatCount(o.outputTokens)}</div>
          <div className="stat-note">Included in the generation price</div>
        </div>
      </section>
    </>
  );
}
