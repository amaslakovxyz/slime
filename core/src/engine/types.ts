// The Slime instance API (PLAN.md §5).
import type { SlimeMode } from '../config/options.js';
import type { StepTiming } from './execute-steps.js';
import type { HandlerProvenance } from '../request/key.js';
import type { SlimeRequest } from '../request/parse.js';
import type { ReviewStatus, StoredTier, Tier } from '../handler/record.js';

export type CacheOutcome = 'hit' | 'miss' | 'coalesced';


export interface QueryTimings {
  total: number;
  generate?: number;
  run: number;
  shape: number;
}

export interface QueryMeta {
  handlerKey: string;
  tier: Tier;
  cache: CacheOutcome;
  /** rowCap cut the rows. */
  truncated: boolean;
  timingsMs: QueryTimings;
  warnings: string[];
  review: ReviewStatus;
  /** Explore mode only: what each step read (R9). */
  steps?: StepTiming[];
  /** sql, shapeJs and assumptions: explore mode only (R9). */
  sql?: string;
  shapeJs?: string;
  assumptions?: string[];
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
  mode: SlimeMode;
  handlers: Record<StoredTier, number>;
  generationsThisHour: number;
  generationsInFlight: number;
}

export interface Slime {
  query(request: SlimeRequest): Promise<QueryResult>;
  handlers(): HandlerSummary[];
  stats(): SlimeStats;
  /** The provenance new handlers are made with; saved ones that differ are regenerated in explore mode. */
  provenance(): HandlerProvenance;
  /** Removes the handler from memory and the store; false if it was unknown. */
  evict(handlerKey: string): Promise<boolean>;
  /** Waits for queued store writes and running reviews; call it before each response on Lambda (C15). */
  flush(): Promise<void>;
  /** Closes the shaping sandbox, the store and the connector. */
  close(): Promise<void>;
}
