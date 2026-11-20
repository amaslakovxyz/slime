// Cache keys (PLAN.md §4.3, R2–R4).
//
// The request key covers what the caller asked: the normalized intent, the
// input NAMES and the output shape. Never input values (they are bound as
// parameters) and never input types (the handler records those, R4).
//
// The request key alone is the handler's store key (§4.7). Where a handler came
// from (schema, dictionary, prompt, model) is stored inside it as provenance,
// not hashed into the key, so locked mode, which has no generator and may run
// against a slightly different schema, can still find what explore mode saved.
import { createHash } from 'node:crypto';
import type { ParsedRequest } from './parse.js';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
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

/**
 * Lowercase, Unicode NFKC, one space between words, no trailing `.!?;:,`.
 * Deliberately nothing more (R3): no synonyms and no model, so the key is
 * deterministic.
 */
export function normalizeIntent(intent: string): string {
  return intent
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?;:,]+$/, '')
    .trimEnd();
}

/** Same question asked the same way: same key. 64 hex characters. */
export function requestKey(req: ParsedRequest): string {
  return sha256(
    canonicalJSON({
      v: 1,
      intent: normalizeIntent(req.intent),
      input: Object.keys(req.input).sort(),
      output: req.output,
    }),
  );
}

/** What a handler was generated against. Stored with the handler, never part of its key. */
export interface HandlerProvenance {
  schemaHash: string;
  /** Hash of the dictionary (§4.4), which includes the glossary and rules. */
  dictionaryHash: string;
  promptHash: string;
  /** The model's name, as the generator reports it. */
  model: string;
}

const PROVENANCE_FIELDS: readonly (keyof HandlerProvenance)[] = ['schemaHash', 'dictionaryHash', 'promptHash', 'model'];

/**
 * The provenance fields that differ between a saved handler and the current
 * setup, in a fixed order. Explore mode treats any difference as a miss and
 * regenerates; locked mode serves the handler anyway and warns when
 * `schemaHash` is among them (§4.7).
 */
export function changedProvenance(saved: HandlerProvenance, current: HandlerProvenance): (keyof HandlerProvenance)[] {
  return PROVENANCE_FIELDS.filter((field) => saved[field] !== current[field]);
}
