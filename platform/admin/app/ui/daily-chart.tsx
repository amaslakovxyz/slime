// Stacked daily requests by tier. Bars live in a stretched SVG
// (preserveAspectRatio="none") so they fill any width; axis labels are HTML so
// text never gets distorted.
import { formatCompact, formatCount } from '@/app/format';
import type { DayUsage } from '@/lib/endpoints';

// Bottom to top: the cheap, fast tiers form the base the month grows on.
const STACK = ['crystal', 'liquid', 'gas'] as const;
const SLOT = 10;
const BAR = 6.4;

/** Smallest 1/2/2.5/5 x 10^n step that fits `max` in four gridlines. */
function niceStep(max: number): number {
  const raw = Math.max(max, 4) / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow;
}

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function DailyChart({ id, daily, height = 220 }: { id: string; daily: DayUsage[]; height?: number }) {
  const totals = daily.map((d) => d.gas + d.liquid + d.crystal);
  const step = niceStep(Math.max(0, ...totals));
  const top = step * 4;
  const slots = Math.max(daily.length, 14);
  const width = slots * SLOT;
  const every = daily.length > 20 ? 5 : daily.length > 10 ? 2 : 1;
  const sum = (tier: (typeof STACK)[number]) => daily.reduce((s, d) => s + d[tier], 0);
  const empty = totals.every((t) => t === 0);

  return (
    <figure className="chart">
      <div className="chart-body" style={{ height }}>
        <div className="chart-y" aria-hidden="true">
          {/* An empty month has no scale worth reading. */}
          {!empty &&
            [0, 1, 2, 3, 4].map((i) => (
              <span key={i} style={{ bottom: `${i * 25}%` }}>
                {formatCompact(i * step)}
              </span>
            ))}
        </div>
        <div className="chart-plot">
          <svg
            viewBox={`0 0 ${width} 100`}
            preserveAspectRatio="none"
            role="img"
            aria-labelledby={`${id}-title ${id}-desc`}
          >
            <title id={`${id}-title`}>Daily requests by tier</title>
            <desc id={`${id}-desc`}>
              {`${daily.length} days. Gas ${formatCount(sum('gas'))}, Liquid ${formatCount(sum('liquid'))}, Crystal ${formatCount(sum('crystal'))} requests.`}
            </desc>
            {[1, 2, 3, 4].map((i) => (
              <line key={i} className="chart-grid" x1={0} x2={width} y1={100 - i * 25} y2={100 - i * 25} vectorEffect="non-scaling-stroke" />
            ))}
            {daily.map((d, i) => {
              let y = 100;
              return (
                <g key={d.day}>
                  <title>{`${dayLabel(d.day)}: ${formatCount(totals[i])} requests (Gas ${formatCount(d.gas)}, Liquid ${formatCount(d.liquid)}, Crystal ${formatCount(d.crystal)})`}</title>
                  <rect className="chart-hit" x={i * SLOT} y={0} width={SLOT} height={100} />
                  {STACK.map((tier) => {
                    const h = (d[tier] / top) * 100;
                    y -= h;
                    return h > 0 ? (
                      <rect key={tier} className={`bar-${tier}`} x={i * SLOT + (SLOT - BAR) / 2} y={y} width={BAR} height={h} />
                    ) : null;
                  })}
                </g>
              );
            })}
            <line className="chart-axis" x1={0} x2={width} y1={100} y2={100} vectorEffect="non-scaling-stroke" />
          </svg>
          {empty && <div className="chart-empty">No traffic yet this month</div>}
        </div>
      </div>
      <div className="chart-x" aria-hidden="true">
        {daily.map((d, i) =>
          i % every === 0 ? (
            <span key={d.day} style={{ left: `${((i + 0.5) / slots) * 100}%` }}>
              {Number(d.day.slice(8))}
            </span>
          ) : null,
        )}
      </div>
      <figcaption className="legend">
        <span>
          <i className="swatch swatch-gas" /> Gas
        </span>
        <span>
          <i className="swatch swatch-liquid" /> Liquid
        </span>
        <span>
          <i className="swatch swatch-crystal" /> Crystal
        </span>
      </figcaption>
    </figure>
  );
}
