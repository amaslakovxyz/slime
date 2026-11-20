import crypto from 'node:crypto';

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** JSON with object keys sorted at every level, so key order never changes a hash. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizeIntent(intent: string): string {
  return intent
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?;:,]+$/, '');
}

export function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Input key names and types, sorted. Values are never part of the key. */
export function inputSignature(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((k) => [k, jsonType(input[k])]),
  );
}

/** Same question asked the same way: same fingerprint. */
export function requestFingerprint(intent: string, inputSig: Record<string, string>, output: unknown): string {
  return sha256(canonicalJSON({ v: 1, intent: normalizeIntent(intent), inputSig, output }));
}

/**
 * Fingerprint plus everything that changes what the generated code would be.
 * A schema, prompt or model change produces a new key, so stale code is never reused.
 */
export function artifactKey(parts: {
  fingerprint: string;
  schemaHash: string;
  promptHash: string;
  model: string;
}): string {
  return sha256(canonicalJSON({ artifactVersion: 1, ...parts })).slice(0, 24);
}

/** Literals in the intent usually mean the caller put a value where `input` belongs. */
export function literalWarnings(intent: string): string[] {
  const found: string[] = [];
  if (/["'][^"']+["']/.test(intent)) found.push('quoted text');
  if (/\b\d{2,}\b/.test(intent)) found.push('a number');
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(intent)) found.push('an email address');
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-/i.test(intent)) found.push('an ID');
  return found.length
    ? [`intent contains ${found.join(', ')}. Put values in "input" so the cached handler is reused for other values.`]
    : [];
}
