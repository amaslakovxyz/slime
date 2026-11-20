export const formatCount = (n: number) => n.toLocaleString('en-US');
export const formatUsd = (usd: number) => `$${usd.toFixed(2)}`;
export const formatDate = (iso: string) => iso.slice(0, 16).replace('T', ' ') + ' UTC';
