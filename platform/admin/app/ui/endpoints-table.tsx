import Link from 'next/link';
import { formatCount, formatUsd } from '@/app/format';
import { StatusBadge } from '@/app/ui/status-badge';
import { CONNECTOR_SPECS } from '@/lib/connectors';
import type { EndpointWithStats } from '@/lib/endpoints';

function TierMix({ row }: { row: EndpointWithStats }) {
  const { gas, liquid, crystal } = row.stats.tiers;
  const total = gas.requests + liquid.requests + crystal.requests;
  if (total === 0) return <span className="muted">—</span>;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <span
      className="mix"
      role="img"
      aria-label={`Gas ${pct(gas.requests)}, Liquid ${pct(liquid.requests)}, Crystal ${pct(crystal.requests)}`}
    >
      <span className="mix-gas" style={{ width: pct(gas.requests) }} />
      <span className="mix-liquid" style={{ width: pct(liquid.requests) }} />
      <span className="mix-crystal" style={{ width: pct(crystal.requests) }} />
    </span>
  );
}

/** `compact` for the overview; the full variant adds URL, token, connector and handlers. */
export function EndpointsTable({ rows, compact = false }: { rows: EndpointWithStats[]; compact?: boolean }) {
  return (
    <div className="card table-card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              {!compact && <th>Provider</th>}
              {!compact && <th>URL</th>}
              {!compact && <th>Token</th>}
              <th>Tier mix</th>
              <th className="num">Requests</th>
              {compact ? <th className="num">Estimate</th> : <th className="num">Liquid handlers</th>}
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((ep) => (
              <tr key={ep.endpointId}>
                <td className="cell-name">
                  <Link href={`/endpoints/${ep.endpointId}`}>{ep.name}</Link>
                  <span className="cell-sub">{ep.endpointId}</span>
                </td>
                <td>
                  <StatusBadge status={ep.status} />
                </td>
                {!compact && (
                  <td>
                    {ep.provider}
                    <span className="cell-sub">{CONNECTOR_SPECS[ep.connectorType].label}</span>
                  </td>
                )}
                {!compact && <td className="mono cell-url">{ep.url ?? <span className="muted">—</span>}</td>}
                {!compact && <td className="mono">slm_…{ep.tokenHint}</td>}
                <td>
                  <TierMix row={ep} />
                </td>
                <td className="num">{formatCount(ep.stats.requests)}</td>
                {compact ? (
                  <td className="num">{formatUsd(ep.stats.estimatedUsd)}</td>
                ) : (
                  <td className="num">
                    {ep.stats.liquidHandlers === null ? (
                      <span className="muted">—</span>
                    ) : (
                      formatCount(ep.stats.liquidHandlers)
                    )}
                  </td>
                )}
                <td className="muted">{ep.createdAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
