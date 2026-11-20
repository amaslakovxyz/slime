// Cache keys (PLAN.md §4.3, R2–R4).
//
// The request key covers what the caller asked: the normalized intent, the
// input NAMES and the output shape. Never input values (they are bound as
// parameters) and never input types (the handler records those, R4).
//
// A handler is reusable only under the same scope: the same schema, dictionary,
// prompt and model. The store key is `${scope}#${requestKey}`, so "every handler
// of this scope" is one list() by prefix (C13).
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

/** Everything besides the request that changes what code would be generated. */
export interface HandlerScope {
  schemaHash: string;
  /** Hash of the startup dictionary (§4.4), including the glossary and rules. */
  dictionaryHash: string;
  promptHash: string;
  model: string;
}

/** 16 hex characters; a schema, dictionary, prompt or model change gives a new scope. */
export function scopeKey(scope: HandlerScope): string {
  return sha256(canonicalJSON({ v: 1, ...scope })).slice(0, 16);
}

/** Store key of a Gas or Liquid handler: list(ns, `${scope}#`) loads a whole scope. */
export function handlerKey(scope: string, request: string): string {
  return `${scope}#${request}`;
}
