// API rows cross into the sandbox as JSON text; anything JSON can't carry is an
// adapter bug, refused before it can throw inside JSON.stringify (S4). SQL rows
// keep today's handling: pg Date values become ISO strings there.
import { SlimeError } from '../shared/errors.js';

const NOT_PLAIN_TYPES = new Set(['bigint', 'function', 'symbol', 'undefined']);

export interface RowsOrigin {
  stepName: string;
  sourceName: string;
}

export function assertPlainRows(rows: readonly unknown[], { stepName, sourceName }: RowsOrigin): void {
  const offending = rows.map(firstNonPlainType).find((type) => type !== undefined);
  if (offending === undefined) return;
  throw new SlimeError('SOURCE_ERROR', `Step "${stepName}": source "${sourceName}" returned a ${offending} value, which is not plain JSON.`, {
    details: { source: sourceName, step: stepName },
  });
}

function firstNonPlainType(value: unknown): string | undefined {
  if (NOT_PLAIN_TYPES.has(typeof value)) return typeof value;
  if (value === null || typeof value !== 'object' || value instanceof Date) return undefined;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.map(firstNonPlainType).find((type) => type !== undefined);
}
