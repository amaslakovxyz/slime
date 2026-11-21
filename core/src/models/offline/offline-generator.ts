// Serves hand-written handlers instead of calling a model, so tests, CI and
// benchmarks run without an API key.
import type { AnyArtifact } from '../artifact-v2.js';
import type { Artifact, GenerationResult, Generator } from '../types.js';
import { normalizeIntent } from '../../request/key.js';
import { canonicalJSON, sha256 } from '../../shared/hash.js';

/** Hand-written handlers, keyed by intent; intents match after the cache key's normalization (R3). */
export type OfflineHandlers = Readonly<Record<string, AnyArtifact>>;

const OFFLINE_MODEL = 'offline';
const NO_USAGE = { ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 };
const MISSING_HANDLER: Artifact = {
  unsatisfiable: 'No offline handler for this intent. Add it to the offline handlers.',
  sql: '',
  params: [],
  shapeJs: null,
  assumptions: [],
};

export function offlineGenerator(handlers: OfflineHandlers): Generator {
  const byIntent = new Map(Object.entries(handlers).map(([intent, artifact]) => [normalizeIntent(intent), artifact]));
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
