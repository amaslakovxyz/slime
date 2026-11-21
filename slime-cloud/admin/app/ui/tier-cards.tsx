import { formatCount, formatMs, formatShare } from '@/app/format';
import type { Usage } from '@/lib/endpoints';
import type { Tier } from '@/lib/pricing';

const WARM = 'warm, last seen instance';

const TIER_COPY: Record<Tier, { tag: string; name: string; desc: string; handlersLabel: string; handlersTitle: string }> = {
  gas: {
    tag: 'TIER 0 · GAS',
    name: 'Gas',
    desc: 'Intent synthesis with the LLM in the loop',
    handlersLabel: 'warm handlers',
    handlersTitle: WARM,
  },
  liquid: {
    tag: 'TIER 1 · LIQUID',
    name: 'Liquid',
    desc: 'Stored plasma handlers, no generation',
    handlersLabel: 'stored handlers',
    handlersTitle: 'Handlers persisted in slime-handlers',
  },
  crystal: {
    tag: 'TIER 2 · CRYSTAL',
    name: 'Crystal',
    desc: 'Compiled hot paths, sub-millisecond',
    handlersLabel: 'crystals',
    handlersTitle: WARM,
  },
};

function handlerCount(usage: Usage, tier: Tier): number | null {
  if (tier === 'gas') return usage.gasHandlers;
  if (tier === 'crystal') return usage.crystalHandlers;
  return usage.liquidHandlers;
}

export function TierCards({ usage }: { usage: Usage }) {
  const total = usage.tiers.gas.requests + usage.tiers.liquid.requests + usage.tiers.crystal.requests;
  return (
    <div className="tiers">
      {(Object.keys(TIER_COPY) as Tier[]).map((tier) => {
        const copy = TIER_COPY[tier];
        const t = usage.tiers[tier];
        const handlers = handlerCount(usage, tier);
        return (
          <article className={`tier tier-${tier}`} key={tier} aria-label={`${copy.name} tier`}>
            <div className="tier-head">
              <span className="tier-tag">{copy.tag}</span>
              <span className="tier-share mono">{formatShare(t.requests, total)}</span>
            </div>
            <h3 className="tier-name">{copy.name}</h3>
            <p className="tier-desc">{copy.desc}</p>
            <div className="tier-latency">
              <span className="mono">{formatMs(t.avgMs)}</span>
              <span className="tier-latency-label">avg latency</span>
            </div>
            <dl className="tier-metrics">
              <div>
                <dt>requests this month</dt>
                <dd className="mono">{formatCount(t.requests)}</dd>
              </div>
              <div title={copy.handlersTitle}>
                <dt>
                  {copy.handlersLabel}
                  {copy.handlersTitle === WARM && <sup aria-hidden="true">*</sup>}
                </dt>
                <dd className="mono">{handlers === null ? '—' : formatCount(handlers)}</dd>
              </div>
            </dl>
          </article>
        );
      })}
      <p className="tiers-foot">* {WARM}: the handler counts the runtime instance that flushed last reported.</p>
    </div>
  );
}
