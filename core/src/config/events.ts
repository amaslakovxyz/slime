// What onEvent receives: observability only, never control flow.
import type { Step } from '../artifact/artifact.js';

/** Carries the generated code so a dev setup can print it (R9). */
export interface GeneratedEvent {
  type: 'generated';
  handlerKey: string;
  sql: string;
  shapeJs?: string;
  /** `sql` holds the SQL steps joined. */
  steps: Step[];
  assumptions: string[];
  tokens: number;
  ms: number;
}

export interface ReviewedEvent {
  type: 'reviewed';
  handlerKey: string;
  verdict: 'approved' | 'rejected';
  notes: string;
}

export interface PromotedEvent {
  type: 'promoted';
  handlerKey: string;
  tier: 'liquid';
}

export interface WarningEvent {
  type: 'warning';
  message: string;
}

export interface ErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

/** A Liquid handler reached `tiers.crystalReadyRuns` with an approved (or no) review; once per handler per instance. */
export interface CrystalReadyEvent {
  type: 'crystalReady';
  handlerKey: string;
  runs: number;
}

export type SlimeEvent = GeneratedEvent | ReviewedEvent | PromotedEvent | CrystalReadyEvent | WarningEvent | ErrorEvent;
