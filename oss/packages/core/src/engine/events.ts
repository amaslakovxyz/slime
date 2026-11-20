import type { SlimeEvent } from '../config/options.js';

/** A bug in the app's event handler must not fail a query. */
export function emitSafely(onEvent: (event: SlimeEvent) => void, event: SlimeEvent): void {
  try {
    onEvent(event);
  } catch {
    // Ignored on purpose: events are observability, not control flow.
  }
}
