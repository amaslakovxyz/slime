import type { SlimeEvent } from '../config/events.js';
import { canonicalJSON } from '../shared/hash.js';
import type { InputValues } from '../request/parse.js';
import type { SlimeStore } from '../stores/types.js';
import type { BackgroundTasks } from './background.js';
import { type HandlerCache } from './handler-cache.js';
import { HANDLERS_NS } from '../handler/record.js';
import type { ReviewOutcome } from './generation/review-loop.js';
import type { HandlerRecord } from '../handler/record.js';

export interface PromotionDeps {
  store: SlimeStore;
  cache: HandlerCache;
  background: BackgroundTasks;
  gasToLiquidRuns: number;
  fixturesPerHandler: number;
  crystalReadyRuns: number;
  /** Undefined when no reviewer is configured: handlers are then promoted after their runs alone. */
  review: ((record: HandlerRecord) => Promise<ReviewOutcome>) | undefined;
  emit: (event: SlimeEvent) => void;
}

/** Gas → Liquid (§7, M4 rule): enough successful runs, then an approved review when a reviewer is set. */
export class HandlerPromotion {
  readonly #deps: PromotionDeps;
  // One review at a time: reviews are background work and share the generation limits.
  #reviewQueue: Promise<void> = Promise.resolve();
  // crystalReady is said once per handler and instance; acting on it is the host's call.
  readonly #announced = new Set<string>();

  constructor(deps: PromotionDeps) {
    this.#deps = deps;
  }

  /** Counts a successful run of a saved or cached handler, then checks for promotion. */
  recordRun(record: HandlerRecord, input: InputValues): void {
    record.runs++;
    const fixture = canonicalJSON(input);
    const isNewInput = !record.fixtures.some((saved) => canonicalJSON(saved) === fixture);
    if (isNewInput && record.fixtures.length < this.#deps.fixturesPerHandler) record.fixtures.push(structuredClone(input));
    this.afterRun(record);
  }

  afterRun(record: HandlerRecord): void {
    this.#announceIfReady(record);
    if (record.tier !== 'gas' || record.runs < this.#deps.gasToLiquidRuns) return;
    const { review } = this.#deps;
    if (!review) return this.#promote(record);
    // 'pending' is under review; 'rejected' gave up after maxReviews.
    if (record.review !== 'none') return;
    record.review = 'pending';
    const reviewed = this.#reviewQueue.then(() => this.#review(record, review));
    this.#reviewQueue = reviewed.catch(() => {});
    this.#deps.background.run(() => reviewed);
  }

  async #review(record: HandlerRecord, review: (record: HandlerRecord) => Promise<ReviewOutcome>): Promise<void> {
    try {
      record.review = await review(record);
    } catch (error) {
      record.review = 'none'; // a failed review call is retried after the next run
      throw error;
    }
    if (record.review === 'approved') this.#promote(record);
  }

  #promote(record: HandlerRecord): void {
    record.tier = 'liquid';
    this.#deps.cache.keep(record.key);
    this.#deps.emit({ type: 'promoted', handlerKey: record.key, tier: 'liquid' });
    this.#announceIfReady(record);
    const saved = structuredClone(record);
    this.#deps.background.run(() => this.#deps.store.put(HANDLERS_NS, record.key, saved));
  }

  // The same readiness the crystallize job checks: Liquid, enough runs, and a review that passed or never ran.
  #announceIfReady(record: HandlerRecord): void {
    const hasPassedReview = record.review === 'approved' || record.review === 'none';
    if (record.tier !== 'liquid' || !hasPassedReview || record.runs < this.#deps.crystalReadyRuns || this.#announced.has(record.key)) return;
    this.#announced.add(record.key);
    this.#deps.emit({ type: 'crystalReady', handlerKey: record.key, runs: record.runs });
  }
}
