// Cache keys (§4.3, R2–R4). The request key alone is a handler's store key.
// Provenance is stored inside the handler, not hashed into the key, so locked
// mode, which has no generator, finds what explore mode saved (§4.7).
import { createHash } from 'node:crypto';
import { parseRequest, type ParsedRequest, type SlimeRequest } from './parse.js';

// Bumping it invalidates every saved handler.
const KEY_VERSION = 1;
const WHITESPACE_RUN = /\s+/g;
const TRAILING_PUNCTUATION = /[.!?;:,]+$/;

export interface HandlerProvenance {
  schemaHash: string;
  dictionaryHash: string;
  promptHash: string;
  model: string;
}

const PROVENANCE_FIELDS = ['schemaHash', 'dictionaryHash', 'promptHash', 'model'] as const satisfies readonly (keyof HandlerProvenance)[];

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

// R3: no synonyms and no model, so the key stays deterministic.
export function normalizeIntent(intent: string): string {
  return intent.normalize('NFKC').toLowerCase().replace(WHITESPACE_RUN, ' ').trim().replace(TRAILING_PUNCTUATION, '').trimEnd();
}

export function requestKey(request: ParsedRequest): string {
  return sha256(
    canonicalJSON({
      v: KEY_VERSION,
      intent: normalizeIntent(request.intent),
      input: Object.keys(request.input).sort(),
      output: request.output,
    }),
  );
}

/** Explore mode regenerates on any change; locked mode serves the handler and warns on schemaHash (§4.7). */
export function changedProvenance(saved: HandlerProvenance, current: HandlerProvenance): (keyof HandlerProvenance)[] {
  return PROVENANCE_FIELDS.filter((field) => saved[field] !== current[field]);
}

/** The key a request's handler is stored, served and evicted under; throws INVALID_REQUEST like query(). */
export function handlerKeyFor(request: SlimeRequest): string {
  return requestKey(parseRequest(request));
}
