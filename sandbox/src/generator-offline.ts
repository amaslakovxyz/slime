// Offline generator: serves hand-written handlers from a JSON file instead of
// calling a model. Lets the engine, server and benchmark run without an API key
// (tests and CI), and separates Slime's own overhead from model time.
import { readFileSync } from 'node:fs';
import { normalizeIntent } from './fingerprint.js';
import type { GenerationRequest, GenerationResult, Generator } from './generator.js';
import { ArtifactSchema, type Artifact } from './prompts.js';
import type { ReviewRequest, ReviewResult, Reviewer } from './review.js';

export class OfflineGenerator implements Generator {
  private readonly byIntent: Map<string, Artifact>;

  /** Keys are intents (matched after the same normalization as cache keys). */
  constructor(handlers: Record<string, unknown>) {
    this.byIntent = new Map(
      Object.entries(handlers).map(([intent, a]) => [normalizeIntent(intent), ArtifactSchema.parse(a)]),
    );
  }

  static fromFile(path: string): OfflineGenerator {
    return new OfflineGenerator(JSON.parse(readFileSync(path, 'utf8')));
  }

  async generate(req: GenerationRequest): Promise<GenerationResult> {
    const artifact = this.byIntent.get(normalizeIntent(req.intent)) ?? {
      unsatisfiable: `No offline handler for this intent. Add it to the offline handlers file.`,
      sql: '',
      params: [],
      shapeJs: null,
      assumptions: [],
    };
    return { artifact, ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  }
}

/** Approves everything: offline handlers are written and checked by people. */
export class OfflineReviewer implements Reviewer {
  readonly model = 'offline';
  async review(_req: ReviewRequest): Promise<ReviewResult> {
    return { verdict: 'approve', problems: [], ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 };
  }
}
