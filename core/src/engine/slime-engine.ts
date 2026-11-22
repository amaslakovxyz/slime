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
import { queryMeta } from './meta.js';
import { reviewUntilSettled, type ReviewOutcome } from './generation/review-loop.js';
import type { CacheOutcome, HandlerSummary, QueryResult, Slime, SlimeStats } from './types.js';
import type { HandlerRecord } from '../handler/record.js';

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
  generateMs?: number;
}

export class SlimeEngine implements Slime {
  readonly #parts: EngineParts;
  readonly #cache: HandlerCache;
  readonly #limits: GenerationLimits;
  readonly #background: BackgroundTasks;
  readonly #promotion: HandlerPromotion;
  readonly #generations = new Coalescer<GenerationOutcome>();

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
      review: this.#reviewFunction(),
      emit: (event) => this.#emit(event),
    });
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
    const request = parseRequest(raw);
    const key = requestKey(request);
    const crystal = this.#parts.config.crystal ? this.#parts.config.crystal[key] : undefined;
    if (crystal) return answerFromCrystal(this.#parts, { key, crystal, request, startedAt });

    const { record, cache, firstRun, generateMs } = await this.#resolve(key, request);
    const execution = firstRun ?? (await this.#runSaved(record, request.input));
    const { tier, review, artifact, intent } = record;
    const meta = queryMeta({ handlerKey: key, tier, cache, review, execution, code: { sql: sqlOf(artifact), shapeJs: artifact.shapeJs, assumptions: artifact.assumptions }, intent, totalMs: performance.now() - startedAt, ...(generateMs === undefined ? {} : { generateMs }) });
    return { data: execution.data, meta };
  }



  async #resolve(key: string, request: ParsedRequest): Promise<ResolvedHandler> {
    const found = await this.#cache.find(key);
    if (found) return { record: found, cache: 'hit' };
    const { promise, isShared } = this.#generations.run(key, () => this.#generate(this.#parts.config.generator, key, request));
    const outcome = await promise;
    if (isShared) return { record: outcome.record, cache: 'coalesced' };
    return { record: outcome.record, cache: 'miss', firstRun: outcome.execution, generateMs: outcome.usage.ms };
  }

  async #generate(generator: Generator, key: string, request: ParsedRequest): Promise<GenerationOutcome> {
    const releaseSlot = await this.#limits.acquire();
    try {
      const outcome = await generateHandler(generationDeps(this.#parts, generator), { key, request });
      this.#cache.addGas(outcome.record);
      this.#emit(generatedEvent(outcome.record, outcome.usage));
      this.#promotion.afterRun(outcome.record);
      return outcome;
    } finally {
      releaseSlot();
    }
  }

  async #runSaved(record: HandlerRecord, input: InputValues): Promise<Execution> {
    record.paramTypes = checkParamTypes(record.paramTypes, input);
    const execution = await executeArtifact(executionDeps(this.#parts), { artifact: record.artifact, output: record.output, input });
    this.#promotion.recordRun(record, input);
    return execution;
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
