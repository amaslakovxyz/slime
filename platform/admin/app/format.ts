export const formatCount = (n: number) => n.toLocaleString('en-US');
export const formatUsd = (usd: number) =>
  `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const formatDate = (iso: string) => iso.slice(0, 16).replace('T', ' ') + ' UTC';
/** Brand latency format: `X.XX ms`. */
export const formatMs = (ms: number | null) => (ms === null ? '—' : `${ms.toFixed(2)} ms`);
export const formatCompact = (n: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const formatShare = (part: number, total: number) => (total > 0 ? `${((part / total) * 100).toFixed(1)}%` : '—');
export const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
