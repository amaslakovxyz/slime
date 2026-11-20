// Test doubles shared by the unit tests. No database, no model.
import type { Artifact, Connector, Generator, Reviewer } from '../src/ports.js';

export function artifact(sql: string, params: string[] = [], shapeJs: string | null = null): Artifact {
  return { unsatisfiable: null, sql, params, shapeJs, assumptions: [] };
}

export function fakeConnector(): Connector {
  return {
    name: 'fake',
    describe: async () => ({ dialect: 'postgresql 16', tables: [] }),
    check: async () => ({ cost: 1, ms: 0 }),
    run: async () => ({ rows: [], truncated: false, ms: 0 }),
    safetyCheck: async () => ({ ok: true, user: 'reader', problems: [] }),
    close: async () => {},
  };
}

export function fakeGenerator(): Generator {
  return {
    model: 'fake-model',
    promptHash: 'fake-prompt',
    generate: async () => ({ artifact: artifact('SELECT 1'), ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 }),
  };
}

export function fakeReviewer(): Reviewer {
  return {
    model: 'fake-reviewer',
    review: async () => ({ verdict: 'approve', problems: [], ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 }),
  };
}
