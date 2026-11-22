// A handler as Slime stores and serves it: the model's artifact plus what the
// engine learned running it (§4.7).
import { fromStoredArtifact, type Artifact, type LegacyArtifact } from '../artifact/artifact.js';
import type { HandlerProvenance } from '../request/key.js';
import type { InputValues } from '../request/parse.js';
import type { ParamTypes } from '../request/params.js';
import type { Shape } from '../request/shape.js';

export type Tier = 'gas' | 'liquid' | 'crystal';
export type StoredTier = Exclude<Tier, 'crystal'>;
export type ReviewStatus = 'none' | 'pending' | 'approved' | 'rejected';

/** The store namespace handler records live in. */
export const HANDLERS_NS = 'handlers';

/** What a store keeps under `handlers` / request key (§4.7). */
export interface HandlerRecord {
  key: string;
  intent: string;
  output: Shape;
  artifact: Artifact;
  paramTypes: ParamTypes;
  provenance: HandlerProvenance;
  tier: StoredTier;
  review: ReviewStatus;
  runs: number;
  /** Inputs of successful runs, for Crystal's equivalence test. */
  fixtures: InputValues[];
  createdAt: string;
}

/** A record as a store returns it: older ones hold the single-query artifact. */
type StoredRecord = Omit<HandlerRecord, 'artifact'> & { artifact: Artifact | LegacyArtifact };

/** Every read of a saved handler goes through here, so nothing past the store sees the legacy form. */
export function recordFromStore(value: unknown, sqlSourceName: string): HandlerRecord {
  const stored = value as StoredRecord;
  return { ...stored, artifact: fromStoredArtifact(stored.artifact, sqlSourceName) };
}
