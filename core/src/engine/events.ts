import type { ErrorEvent, GeneratedEvent, SlimeEvent } from '../config/options.js';
import { sqlOf } from '../models/artifact.js';
import { SlimeError } from '../shared/errors.js';
import type { ModelUsage } from '../models/types.js';
import type { HandlerRecord } from './types.js';

const BACKGROUND_FAILED = 'BACKGROUND_FAILED';

/** A bug in the app's event handler must not fail a query. */
export function emitSafely(onEvent: (event: SlimeEvent) => void, event: SlimeEvent): void {
  try {
    onEvent(event);
  } catch {
    // Ignored on purpose: events are observability, not control flow.
  }
}

export function errorEvent(error: unknown): ErrorEvent {
  if (error instanceof SlimeError) return { type: 'error', code: error.code, message: error.message };
  return { type: 'error', code: BACKGROUND_FAILED, message: error instanceof Error ? error.message : String(error) };
}

export function generatedEvent({ key, artifact }: HandlerRecord, usage: ModelUsage): GeneratedEvent {
  return {
    type: 'generated',
    handlerKey: key,
    sql: sqlOf(artifact),
    assumptions: artifact.assumptions,
    tokens: usage.inputTokens + usage.outputTokens,
    ms: usage.ms,
    ...(artifact.shapeJs ? { shapeJs: artifact.shapeJs } : {}),
    steps: artifact.steps,
  };
}
