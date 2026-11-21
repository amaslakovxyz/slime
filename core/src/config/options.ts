import type { CrystalRegistry } from '../engine/crystal/types.js';
import type { Connector } from '../connectors/types.js';
import type { Source } from '../sources/types.js';
import type { Generator, Reviewer } from '../models/types.js';
import type { SlimeStore } from '../stores/types.js';

export interface TierOptions {
  /** Successful runs inside the Gas window before a handler may become Liquid. */
  gasToLiquidRuns: number;
  gasWindowMs: number;
  /** Counts re-reviews after a rejected revision. */
  maxReviews: number;
  /** Inputs of successful runs kept for Crystal's equivalence test. */
  fixturesPerHandler: number;
}

export interface LimitOptions {
  /** Regenerations after a generated handler fails its checks. */
  maxRepairs: number;
  /** Model time for one new request, repairs included. */
  generationBudgetMs: number;
  reviewTimeoutMs: number;
  maxConcurrentGenerations: number;
  /** Per instance (§7, M2). */
  maxGenerationsPerHour: number;
  statementTimeoutMs: number;
  /** More rows are cut and meta.truncated is set. */
  rowCap: number;
  /** In database planner units; a costlier query is refused before it runs. */
  maxQueryCost: number;
  shapeTimeoutMs: number;
  shapeMemoryBytes: number;
  /** Steps in one multi-source handler (MS5). */
  maxSteps: number;
  /** One API step, and an API source's describe() and safetyCheck() (MS5). */
  apiTimeoutMs: number;
}

export type { CrystalRegistry };

export type SlimeMode = 'explore' | 'locked';

/** Carries the generated code so a dev setup can print it (R9). */
export interface GeneratedEvent {
  type: 'generated';
  handlerKey: string;
  sql: string;
  shapeJs?: string;
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

export type SlimeEvent = GeneratedEvent | ReviewedEvent | PromotedEvent | WarningEvent | ErrorEvent;

export interface SlimeOptions {
  /** Shorthand for sources: { db: connector } (MS1). */
  connector?: Connector;
  /** Exactly one SQL source (a Connector) and any number of API sources (MS1). */
  sources?: Record<string, Source>;
  /** Omit for locked mode: only saved handlers are served (C6). */
  generator?: Generator;
  /** Omit to skip reviews. */
  reviewer?: Reviewer;
  /** Omit for the file store in ./.slime, which createSlime() builds (C14). */
  store?: SlimeStore;
  crystal?: CrystalRegistry | false;
  /** For example { revenue: "sum of paid invoices, in cents" }. */
  glossary?: Record<string, string>;
  /** Added to the dictionary (D2). */
  rules?: string[];
  tiers?: Partial<TierOptions>;
  limits?: Partial<LimitOptions>;
  onEvent?: (event: SlimeEvent) => void;
}
