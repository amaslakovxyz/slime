import type { SlimeConfig } from '../config/slime-config.js';
import { sqlOf } from '../artifact/artifact.js';
import type { SlimeEvent } from '../config/events.js';
import type { Dictionary } from '../dictionary/dictionary.js';
import { SlimeError } from '../shared/errors.js';
import { answerFromCrystal } from './crystal/answer.js';
import { executionDeps, generationDeps, sourceSetup } from './engine-deps.js';
import type { Generator } from '../models/types.js';
import type { SandboxRunner } from '../sandbox/types.js';
import { requestKey, type HandlerProvenance } from '../request/key.js';
import { parseRequest, type InputValues, type ParsedRequest, type SlimeRequest } from '../request/parse.js';
import { checkParamTypes } from '../request/params.js';
import type { SlimeStore } from '../stores/types.js';
import type { ApiSchema } from '../sources/api/types.js';
import { closeSources } from '../sources/lifecycle.js';
import { BackgroundTasks } from './background.js';
import { Coalescer } from './coalescer.js';
import { emitSafely, errorEvent, generatedEvent } from './events.js';
import { executeArtifact, type Execution } from './execution/execute.js';
import { generateHandler, type GenerationOutcome } from './generation/generate.js';
import { GenerationLimits } from './generation/limits.js';
import { HandlerCache } from './handler-cache.js';
import { savedHandlerProblem } from '../handler/fits-sources.js';
import { HandlerPromotion } from './promotion.js';
import { registerInternals } from './internals.js';
import { queryMeta, type ResolveTimings } from './meta.js';
import { reviewUntilSettled, type ReviewOutcome } from './generation/review-loop.js';
import type { CacheOutcome, HandlerSummary, QueryResult, Slime, SlimeStats } from './types.js';
import type { HandlerRecord } from '../handler/record.js';
import { Trace, traceReview } from './trace.js';

export interface EngineParts {
  config: SlimeConfig;
  store: SlimeStore;
  runner: SandboxRunner;
  /** False when the host injected the runner and shares it: close() then leaves it running. */
  ownsRunner: boolean;
  dictionary: Dictionary;
  provenance: HandlerProvenance;
  /** API sources' schemas by name; empty without API sources. */
  apiSchemas: Readonly<Record<string, ApiSchema>>;
}

interface ResolvedHandler {
  record: HandlerRecord;
  cache: CacheOutcome;
  /** Set on a miss: the generating run already answered this request. */
  firstRun?: Execution;
  timings: ResolveTimings;
}

/** The generation and how long it waited for a slot; shared with coalesced requests, whose wait is their own. */
interface QueuedGeneration extends GenerationOutcome {
  queueMs: number;
}

// Errors that mean the Crystal no longer fits the data (a migration, a changed column); the
// Liquid handler or a new generation can still answer. A bad input or a timeout would fail there too.
const CRYSTAL_DRIFT_CODES = new Set(['QUERY_ERROR', 'SHAPE_MISMATCH', 'INVALID_HANDLER', 'SANDBOX_ERROR']);
const CRYSTAL_KEY_PREFIX = 12;

function isCrystalDrift(error: unknown): error is SlimeError {
  return error instanceof SlimeError && CRYSTAL_DRIFT_CODES.has(error.code) && error.details?.['isTimeout'] !== true;
}

export class SlimeEngine implements Slime {
  readonly #parts: EngineParts;
  readonly #cache: HandlerCache;
  readonly #limits: GenerationLimits;
  readonly #background: BackgroundTasks;
  readonly #promotion: HandlerPromotion;
  readonly #generations = new Coalescer<QueuedGeneration>();
  // A broken Crystal is reported once per key and instance, not on every request it falls back.
  readonly #reportedCrystals = new Set<string>();

  constructor(parts: EngineParts) {
    const { config, store, provenance } = parts;
    this.#parts = parts;
    const savedContext = { sqlSourceName: config.sqlSourceName, apiSchemas: parts.apiSchemas, maxSteps: config.limits.maxSteps };
    this.#cache = new HandlerCache({ store, provenance, sqlSourceName: config.sqlSourceName, gasWindowMs: config.tiers.gasWindowMs, savedHandlerProblem: (record) => savedHandlerProblem(record, savedContext) });
    this.#limits = new GenerationLimits({ maxPerHour: config.limits.maxGenerationsPerHour, maxConcurrent: config.limits.maxConcurrentGenerations });
    this.#background = new BackgroundTasks((error) => this.#emit(errorEvent(error)));
    this.#promotion = new HandlerPromotion({
      store,
      cache: this.#cache,
      background: this.#background,
      gasToLiquidRuns: config.tiers.gasToLiquidRuns,
      fixturesPerHandler: config.tiers.fixturesPerHandler,
      crystalReadyRuns: config.tiers.crystalReadyRuns,
      review: this.#reviewFunction(),
      emit: (event) => this.#emit(event),
    });
    const { connector, sources, sqlSourceName, limits, tiers } = config;
    const { apiSchemas } = parts;
    registerInternals(this, { connector, sources, sqlSourceName, apiSchemas, store, runner: parts.runner, limits, tiers, liveRecords: () => this.#cache.records() });
  }

  async query(request: SlimeRequest): Promise<QueryResult> {
    try {
      return await this.#answer(request);
    } catch (error) {
      if (error instanceof SlimeError) this.#emit(errorEvent(error));
      throw error;
    }
  }

  handlers(): HandlerSummary[] {
    return this.#cache.summaries();
  }

  stats(): SlimeStats {
    return { handlers: this.#cache.countByTier(), generationsThisHour: this.#limits.generationsThisHour, generationsInFlight: this.#limits.inFlight };
  }

  provenance(): HandlerProvenance {
    return { ...this.#parts.provenance };
  }

  evict(handlerKey: string): Promise<boolean> {
    return this.#cache.evict(handlerKey);
  }

  flush(): Promise<void> {
    return this.#background.settled();
  }

  /** Closes everything it owns, even when one close fails; then rejects with the first failure. */
  async close(): Promise<void> {
    await this.flush();
    const { runner, ownsRunner, store, config } = this.#parts;
    const closed = await Promise.allSettled([ownsRunner ? runner.close() : undefined, store.close?.(), closeSources(sourceSetup(config))]);
    const failed = closed.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  async #answer(raw: unknown): Promise<QueryResult> {
    const startedAt = performance.now();
    const trace = new Trace();
    let key: string | undefined;
    try {
      const request = await trace.time('key', () => parseRequest(raw), { note: (r) => inputsNote(r.input) });
      key = requestKey(request);
      const crystal = this.#parts.config.crystal ? this.#parts.config.crystal[key] : undefined;
      let fallbackWarning: string | undefined;
      let routePrefix = '';
      if (crystal) {
        try {
          return await answerFromCrystal(this.#parts, { key, crystal, request, startedAt, trace });
        } catch (error) {
          if (!isCrystalDrift(error)) throw error;
          fallbackWarning = this.#crystalFailed(key, error);
          routePrefix = `Crystal failed (${error.code}) → `;
          trace.spans.length = 1; // keep only the key span; the fallback's route reads cleanly
        }
      }
      const { record, cache, firstRun, timings } = await this.#resolve(key, request, trace, routePrefix);
      const execution = firstRun ?? (await this.#runSaved(record, request.input, trace));
      const { tier, review, artifact, intent } = record;
      this.#traceAfterRun(trace, record, cache);
      const meta = queryMeta({ handlerKey: key, tier, cache, review, execution, code: { sql: sqlOf(artifact), shapeJs: artifact.shapeJs, assumptions: artifact.assumptions }, intent, totalMs: performance.now() - startedAt, resolve: timings, trace: trace.spans });
      if (fallbackWarning) meta.warnings.push(fallbackWarning);
      return { data: execution.data, meta };
    } catch (error) {
      throw trace.attach(error, key);
    }
  }

  /** The note for meta.warnings; the warning event goes out once per key. */
  #crystalFailed(key: string, error: SlimeError): string {
    const note = `The Crystal handler failed (${error.code}), so this answer came from Liquid or a new handler; crystallize it again after a schema change.`;
    if (!this.#reportedCrystals.has(key)) {
      this.#reportedCrystals.add(key);
      this.#emit({ type: 'warning', message: `Crystal ${key.slice(0, CRYSTAL_KEY_PREFIX)} failed and falls back: ${error.code}: ${error.message}` });
    }
    return note;
  }



  async #resolve(key: string, request: ParsedRequest, trace: Trace, routePrefix: string): Promise<ResolvedHandler> {
    const lookupStartedAt = performance.now();
    const found = await this.#cache.find(key);
    const lookupMs = performance.now() - lookupStartedAt;
    if (found) {
      trace.add('route', 'pass', { note: `${routePrefix}cache hit · ${found.tier}` });
      return { record: found, cache: 'hit', timings: { lookupMs } };
    }
    const waitStartedAt = performance.now();
    const { promise, isShared } = this.#generations.run(key, () => this.#generate(this.#parts.config.generator, key, request, trace, routePrefix));
    if (isShared) {
      trace.add('route', 'pass', { note: `${routePrefix}same request already generating → joined it` });
      trace.add('limits', 'skip', { note: 'joined a generation in flight' });
      const outcome = await promise;
      // A follower's whole wait is queue time: it runs the handler itself afterwards.
      const queueMs = performance.now() - waitStartedAt;
      trace.add('generate', 'skip', { ms: queueMs, note: "waited for the same request's generation" });
      trace.add('lint', 'skip', { note: 'checked in the shared generation' });
      trace.add('cost', 'skip', { note: 'checked in the shared generation' });
      return { record: outcome.record, cache: 'coalesced', timings: { lookupMs, queueMs } };
    }
    const outcome = await promise;
    const { usage, attempts, checksMs, queueMs } = outcome;
    const generation = { modelMs: usage.ms, providerWaitMs: usage.waitMs, checksMs, attempts };
    return { record: outcome.record, cache: 'miss', firstRun: outcome.execution, timings: { lookupMs, queueMs, generation } };
  }

  async #generate(generator: Generator, key: string, request: ParsedRequest, trace: Trace, routePrefix: string): Promise<QueuedGeneration> {
    trace.add('route', 'pass', { note: `${routePrefix}cache miss → generate` });
    const { maxGenerationsPerHour } = this.#parts.config.limits;
    const queueStartedAt = performance.now();
    const releaseSlot = await trace.time('limits', () => this.#limits.acquire(), { note: () => `${this.#limits.generationsThisHour} of ${maxGenerationsPerHour} this hour` });
    const queueMs = performance.now() - queueStartedAt;
    try {
      const outcome = await generateHandler(generationDeps(this.#parts, generator), { key, request, trace });
      this.#cache.addGas(outcome.record);
      this.#emit(generatedEvent(outcome.record, outcome.usage));
      this.#promotion.afterRun(outcome.record);
      return { ...outcome, queueMs };
    } finally {
      releaseSlot();
    }
  }

  async #runSaved(record: HandlerRecord, input: InputValues, trace: Trace): Promise<Execution> {
    if (!trace.spans.some((s) => s.layer === 'generate')) {
      trace.add('limits', 'skip', { note: 'no model call' });
      trace.add('generate', 'skip', { note: `code written ${record.createdAt.slice(0, 10)}` });
      trace.add('lint', 'skip', { note: 'checked when generated' });
      trace.add('cost', 'skip', { note: 'checked when generated' });
    }
    try {
      record.paramTypes = checkParamTypes(record.paramTypes, input);
      const execution = await executeArtifact(executionDeps(this.#parts), { artifact: record.artifact, output: record.output, input });
      trace.addExecution(execution);
      this.#promotion.recordRun(record, input);
      return execution;
    } catch (error) {
      trace.fail(error);
      throw error;
    }
  }

  /** The cache and review spans, after the run counted. */
  #traceAfterRun(trace: Trace, record: HandlerRecord, cache: CacheOutcome): void {
    const { gasToLiquidRuns, crystalReadyRuns } = this.#parts.config.tiers;
    const progress = record.tier === 'liquid' ? `${record.runs} of ${crystalReadyRuns} runs to Crystal-ready` : `${record.runs} of ${gasToLiquidRuns} runs to Liquid`;
    trace.add('cache', 'pass', { note: cache === 'miss' ? `kept as Gas · ${progress}` : progress });
    traceReview(trace, record.review, Boolean(this.#parts.config.reviewer), gasToLiquidRuns);
  }

  #reviewFunction(): ((record: HandlerRecord) => Promise<ReviewOutcome>) | undefined {
    const { generator, reviewer, limits } = this.#parts.config;
    if (!reviewer) return undefined;
    const deps = { reviewer, generation: generationDeps(this.#parts, generator), limits: this.#limits, maxReviews: this.#parts.config.tiers.maxReviews, reviewTimeoutMs: limits.reviewTimeoutMs, emit: (event: SlimeEvent) => this.#emit(event) };
    return (record) => reviewUntilSettled(deps, record);
  }

  #emit(event: SlimeEvent): void {
    emitSafely(this.#parts.config.onEvent, event);
  }
}

function inputsNote(input: InputValues): string {
  const names = Object.keys(input);
  return names.length ? `inputs: ${names.join(', ')}` : 'no inputs';
}
