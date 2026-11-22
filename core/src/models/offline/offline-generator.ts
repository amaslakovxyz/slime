// Serves hand-written handlers instead of calling a model, so tests, CI and
// benchmarks run without an API key.
import { ARTIFACT_VERSION, fromStoredArtifact, type Artifact, type LegacyArtifact } from '../../artifact/artifact.js';
import type { GenerationResult, Generator } from '../types.js';
import { normalizeIntent } from '../../request/key.js';
import { canonicalJSON, sha256 } from '../../shared/hash.js';

/** Hand-written handlers, keyed by intent; intents match after the cache key's normalization (R3). The single-query form is accepted too. */
export type OfflineHandlers = Readonly<Record<string, Artifact | LegacyArtifact>>;

export interface OfflineOptions {
  /** The SQL source's name, for handlers written in the single-query form. */
  sqlSourceName?: string;
}

const OFFLINE_MODEL = 'offline';
const DEFAULT_SQL_SOURCE_NAME = 'db';
const NO_USAGE = { ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 };
const MISSING_HANDLER: Artifact = {
  version: ARTIFACT_VERSION,
  unsatisfiable: 'No offline handler for this intent. Add it to the offline handlers.',
  steps: [],
  shapeJs: null,
  assumptions: [],
};

export function offlineGenerator(handlers: OfflineHandlers, { sqlSourceName = DEFAULT_SQL_SOURCE_NAME }: OfflineOptions = {}): Generator {
  const byIntent = new Map(Object.entries(handlers).map(([intent, artifact]) => [normalizeIntent(intent), fromStoredArtifact(artifact, sqlSourceName)]));
  return {
    model: OFFLINE_MODEL,
    // The handlers play the role of the prompt: editing them regenerates handlers in explore mode.
    promptHash: sha256(canonicalJSON([...byIntent])),
    async generate(request): Promise<GenerationResult> {
      const artifact = byIntent.get(normalizeIntent(request.intent)) ?? MISSING_HANDLER;
      return { artifact, ...NO_USAGE };
    },
  };
}
