import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Object keys are sorted at every level, so key order never changes a hash. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}
