// Test doubles for apps' and adapters' own tests, and core's: no database, no model.
import type { Connector } from '../connectors/types.js';
import type { Artifact, GenerationRequest, Generator, Reviewer } from '../models/types.js';

export function artifact(sql: string, params: string[] = [], shapeJs: string | null = null): Artifact {
  return { unsatisfiable: null, sql, params, shapeJs, assumptions: [] };
}

export interface ConnectorScript {
  rows?: Record<string, unknown>[];
  cost?: number;
  truncated?: boolean;
  isSafe?: boolean;
}

export interface ScriptedConnector extends Connector {
  readonly runCount: number;
}

/** Answers every query with the scripted rows, cost and truncation. */
export function fakeConnector({ rows = [], cost = 1, truncated = false, isSafe = true }: ConnectorScript = {}): ScriptedConnector {
  let runCount = 0;
  return {
    name: 'fake',
    get runCount() {
      return runCount;
    },
    describe: async () => ({ dialect: 'postgresql 16', tables: [] }),
    check: async () => ({ cost, ms: 0 }),
    run: async () => {
      runCount++;
      return { rows: structuredClone(rows), truncated, ms: 0 };
    },
    safetyCheck: async () => ({ ok: isSafe, user: 'reader', problems: isSafe ? [] : ['the user can INSERT into accounts'] }),
    close: async () => {},
  };
}

export interface StubGenerator extends Generator {
  readonly calls: number;
}

/** Returns `artifactFor(request)` after `delayMs`, and counts its calls. */
export function stubGenerator(artifactFor: (request: GenerationRequest) => Artifact, delayMs = 0): StubGenerator {
  let calls = 0;
  return {
    model: 'stub-model',
    promptHash: 'stub-prompt',
    get calls() {
      return calls;
    },
    generate: async (request) => {
      calls++;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { artifact: artifactFor(request), ms: delayMs, waitMs: 0, inputTokens: 10, outputTokens: 5 };
    },
  };
}

export type Verdict = 'approve' | 'reject';

export interface StubReviewer extends Reviewer {
  readonly calls: number;
}

/** Returns the scripted verdicts in order (the last one repeats); "throw" makes that call fail. */
export function stubReviewer(verdicts: (Verdict | 'throw')[], delayMs = 0): StubReviewer {
  let calls = 0;
  return {
    model: 'stub-reviewer',
    get calls() {
      return calls;
    },
    review: async () => {
      const verdict = verdicts[Math.min(calls, verdicts.length - 1)];
      calls++;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (verdict === 'throw') throw new Error('review call failed');
      const problems = verdict === 'reject' ? ['ranks the least active accounts first'] : [];
      return { verdict: verdict ?? 'approve', problems, ms: delayMs, waitMs: 0, inputTokens: 10, outputTokens: 5 };
    },
  };
}

export function fakeGenerator(): Generator {
  return stubGenerator(() => artifact('SELECT 1'));
}

export function fakeReviewer(): Reviewer {
  return {
    model: 'fake-reviewer',
    review: async () => ({ verdict: 'approve', problems: [], ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 }),
  };
}
