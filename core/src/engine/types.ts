// The Slime instance API (PLAN.md §5).
import type { StepTiming } from './execution/steps.js';
import type { HandlerProvenance } from '../request/key.js';
import type { SlimeRequest } from '../request/parse.js';
import type { ReviewStatus, StoredTier, Tier } from '../handler/record.js';
import type { LayerSpan } from '../shared/trace.js';

export type CacheOutcome = 'hit' | 'miss' | 'coalesced';


/**
 * Where a request's time went. The parts don't overlap, so total minus their sum is only the
 * engine's own bookkeeping (parsing, checks, events): a few ms.
 */
export interface QueryTimings {
  total: number;
  /** Finding the handler: memory, then the store. Absent for a Crystal. */
  lookup?: number;
  /** A miss: waiting for a free generation slot; coalesced: waiting for the shared generation. */
  queue?: number;
  /** A miss: model time over every attempt. */
  generate?: number;
  /** A miss: waits between provider retries (rate limits, backoff); not model time. */
  providerWait?: number;
  /** A miss: checking the model's attempts before the run that answered: every EXPLAIN, and the runs of attempts that failed. */
  checks?: number;
  /** The steps of the run that answered. */
  run: number;
  /** Waiting for a sandbox worker: starting one, or a free one in a busy pool. */
  sandboxWait?: number;
  /** The shaping function itself. */
  shape: number;
}

export interface QueryMeta {
  handlerKey: string;
  tier: Tier;
  cache: CacheOutcome;
  /** rowCap cut the rows. */
  truncated: boolean;
  timingsMs: QueryTimings;
  /** A miss: model calls it took, repairs included. */
  attempts?: number;
  warnings: string[];
  review: ReviewStatus;
  /** What each step read (R9). */
  steps?: StepTiming[];
  /** The code that answered (R9). */
  sql?: string;
  shapeJs?: string;
  assumptions?: string[];
  /** Which harness layers answered this request, in order (request trace design). */
  trace?: LayerSpan[];
}

export interface QueryResult {
  data: unknown;
  meta: QueryMeta;
}

export interface HandlerSummary {
  key: string;
  intent: string;
  tier: StoredTier;
  runs: number;
  review: ReviewStatus;
  createdAt: string;
}

export interface SlimeStats {
  handlers: Record<StoredTier, number>;
  generationsThisHour: number;
  generationsInFlight: number;
}

export interface Slime {
  query(request: SlimeRequest): Promise<QueryResult>;
  handlers(): HandlerSummary[];
  stats(): SlimeStats;
  /** The provenance new handlers are made with; saved ones that differ are generated again. */
  provenance(): HandlerProvenance;
  /** Removes the handler from memory and the store; false if it was unknown. */
  evict(handlerKey: string): Promise<boolean>;
  /** Waits for queued store writes and running reviews; call it before each response on Lambda (C15). */
  flush(): Promise<void>;
  /** Closes the shaping sandbox, the store and the connector. */
  close(): Promise<void>;
}
