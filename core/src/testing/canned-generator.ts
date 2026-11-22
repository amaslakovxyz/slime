// A Generator for tests: serves hand-written handlers by intent instead of
// calling a model, so tests and CI run without an API key.
import { ARTIFACT_VERSION, fromStoredArtifact, type Artifact, type LegacyArtifact } from '../artifact/artifact.js';
import type { GenerationResult, Generator } from '../models/types.js';
import { normalizeIntent } from '../request/key.js';
import { canonicalJSON, sha256 } from '../shared/hash.js';

/** Hand-written handlers, keyed by intent; intents match after the cache key's normalization (R3). The single-query form is accepted too. */
export type CannedHandlers = Readonly<Record<string, Artifact | LegacyArtifact>>;

export interface CannedOptions {
  /** The SQL source's name, for handlers written in the single-query form. */
  sqlSourceName?: string;
}

const CANNED_MODEL = 'canned';
const DEFAULT_SQL_SOURCE_NAME = 'db';
const NO_USAGE = { ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 };
const MISSING_HANDLER: Artifact = {
  version: ARTIFACT_VERSION,
  unsatisfiable: 'No canned handler for this intent.',
  steps: [],
  shapeJs: null,
  assumptions: [],
};

export function cannedGenerator(handlers: CannedHandlers, { sqlSourceName = DEFAULT_SQL_SOURCE_NAME }: CannedOptions = {}): Generator {
  const byIntent = new Map(Object.entries(handlers).map(([intent, artifact]) => [normalizeIntent(intent), fromStoredArtifact(artifact, sqlSourceName)]));
  return {
    model: CANNED_MODEL,
    // The handlers play the role of the prompt: editing them regenerates saved handlers.
    promptHash: sha256(canonicalJSON([...byIntent])),
    async generate(request): Promise<GenerationResult> {
      const artifact = byIntent.get(normalizeIntent(request.intent)) ?? MISSING_HANDLER;
      return { artifact, ...NO_USAGE };
    },
  };
}
