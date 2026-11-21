import type { SlimeConfig } from '../config/slime-config.js';
import type { SlimeEvent } from '../config/options.js';
import type { Dictionary } from '../dictionary/dictionary.js';
import { SlimeError } from '../shared/errors.js';
import { runCrystal } from './crystal/run-crystal.js';
import type { CrystalHandler } from './crystal/types.js';
import type { Generator } from '../models/types.js';
import type { SandboxRunner } from '../sandbox/types.js';
import { requestKey, type HandlerProvenance } from '../request/key.js';
import { parseRequest, type InputValues, type ParsedRequest, type SlimeRequest } from '../request/parse.js';
import { checkParamTypes } from '../request/params.js';
import type { SlimeStore } from '../stores/types.js';
import { BackgroundTasks } from './background.js';
import { Coalescer } from './coalescer.js';
import { emitSafely, errorEvent, generatedEvent } from './events.js';
import { executeArtifact, type Execution } from './execute.js';
import { generateHandler, type GenerationDeps, type GenerationOutcome } from './generate.js';
import { GenerationLimits } from './generation-limits.js';
import { HandlerCache } from './handler-cache.js';
import { HandlerLifecycle } from './lifecycle.js';
import { queryMeta } from './meta.js';
import { reviewUntilSettled, type ReviewOutcome } from './review-loop.js';
import type { CacheOutcome, HandlerRecord, HandlerSummary, QueryResult, Slime, SlimeStats } from './types.js';

export interface EngineParts {
  config: SlimeConfig;
  store: SlimeStore;
  runner: SandboxRunner;
  /** False when the host injected the runner and shares it: close() then leaves it running. */
  ownsRunner: boolean;
  dictionary: Dictionary;
  provenance: HandlerProvenance;
}

interface CrystalAnswer {
  key: string;
  crystal: CrystalHandler;
  request: ParsedRequest;
  startedAt: number;
}

interface ResolvedHandler {
  record: HandlerRecord;
  cache: CacheOutcome;
  /** Set on a miss: the generating run already answered this request. */
  firstRun?: Execution;
  generateMs?: number;
}

const LOCKED_MISS = 'Slime is locked: only saved handlers are served, and none matches this request.';

export class SlimeEngine implements Slime {
  readonly #parts: EngineParts;
  readonly #cache: HandlerCache;
  readonly #limits: GenerationLimits;
  readonly #background: BackgroundTasks;
  readonly #lifecycle: HandlerLifecycle;
  readonly #generations = new Coalescer<GenerationOutcome>();

  constructor(parts: EngineParts) {
    const { config, store, provenance } = parts;
    this.#parts = parts;
    this.#cache = new HandlerCache({ store, mode: config.mode, provenance, gasWindowMs: config.tiers.gasWindowMs });
    this.#limits = new GenerationLimits({ maxPerHour: config.limits.maxGenerationsPerHour, maxConcurrent: config.limits.maxConcurrentGenerations });
    this.#background = new BackgroundTasks((error) => this.#emit(errorEvent(error)));
    this.#lifecycle = new HandlerLifecycle({
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
    return { mode: this.#parts.config.mode, handlers: this.#cache.countByTier(), generationsThisHour: this.#limits.generationsThisHour, generationsInFlight: this.#limits.inFlight };
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

  async close(): Promise<void> {
    await this.flush();
    if (this.#parts.ownsRunner) await this.#parts.runner.close();
    await this.#parts.store.close?.();
    await this.#parts.config.connector.close();
  }

  async #answer(raw: unknown): Promise<QueryResult> {
    const startedAt = performance.now();
    const request = parseRequest(raw);
    const key = requestKey(request);
    const crystal = this.#parts.config.crystal ? this.#parts.config.crystal[key] : undefined;
    if (crystal) return this.#answerFromCrystal({ key, crystal, request, startedAt });

    const { record, cache, firstRun, generateMs } = await this.#resolve(key, request);
    const execution = firstRun ?? (await this.#runSaved(record, request.input));
    const { tier, review, artifact, intent } = record;
    const meta = queryMeta({ handlerKey: key, tier, cache, review, execution, code: artifact, mode: this.#parts.config.mode, intent, totalMs: performance.now() - startedAt, ...(generateMs === undefined ? {} : { generateMs }) });
    return { data: execution.data, meta };
  }

  // Crystal comes first: reviewed, equivalence-tested code that ships with the app (C10).
  async #answerFromCrystal({ key, crystal, request, startedAt }: CrystalAnswer): Promise<QueryResult> {
    checkParamTypes(crystal.paramTypes, request.input);
    const { connector, limits, mode } = this.#parts.config;
    const execution = await runCrystal({ connector, runner: this.#parts.runner, limits }, crystal, request.input);
    const code = { sql: crystal.sql, shapeJs: crystal.shape ? String(crystal.shape) : null, assumptions: [] };
    const meta = queryMeta({ handlerKey: key, tier: 'crystal', cache: 'hit', review: crystal.review, execution, code, mode, intent: request.intent, totalMs: performance.now() - startedAt });
    return { data: execution.data, meta };
  }

  async #resolve(key: string, request: ParsedRequest): Promise<ResolvedHandler> {
    const found = await this.#cache.find(key);
    if (found) return { record: found, cache: 'hit' };
    const { generator } = this.#parts.config;
    if (!generator) throw new SlimeError('HANDLER_NOT_FOUND', LOCKED_MISS);

    const { promise, isShared } = this.#generations.run(key, () => this.#generate(generator, key, request));
    const outcome = await promise;
    if (isShared) return { record: outcome.record, cache: 'coalesced' };
    return { record: outcome.record, cache: 'miss', firstRun: outcome.execution, generateMs: outcome.usage.ms };
  }

  async #generate(generator: Generator, key: string, request: ParsedRequest): Promise<GenerationOutcome> {
    const releaseSlot = await this.#limits.acquire();
    try {
      const outcome = await generateHandler(this.#generationDeps(generator), { key, request });
      this.#cache.addGas(outcome.record);
      this.#emit(generatedEvent(outcome.record, outcome.usage));
      this.#lifecycle.afterRun(outcome.record);
      return outcome;
    } finally {
      releaseSlot();
    }
  }

  async #runSaved(record: HandlerRecord, input: InputValues): Promise<Execution> {
    record.paramTypes = checkParamTypes(record.paramTypes, input);
    const { config, runner } = this.#parts;
    const execution = await executeArtifact({ connector: config.connector, runner, limits: config.limits }, { artifact: record.artifact, output: record.output, input });
    this.#lifecycle.recordRun(record, input);
    return execution;
  }

  #generationDeps(generator: Generator): GenerationDeps {
    const { config, runner, dictionary, provenance } = this.#parts;
    return { generator, connector: config.connector, runner, limits: config.limits, dictionaryText: dictionary.text, provenance };
  }

  #reviewFunction(): ((record: HandlerRecord) => Promise<ReviewOutcome>) | undefined {
    const { generator, reviewer, limits } = this.#parts.config;
    if (!generator || !reviewer) return undefined;
    const deps = { reviewer, generation: this.#generationDeps(generator), limits: this.#limits, maxReviews: this.#parts.config.tiers.maxReviews, reviewTimeoutMs: limits.reviewTimeoutMs, emit: (event: SlimeEvent) => this.#emit(event) };
    return (record) => reviewUntilSettled(deps, record);
  }

  #emit(event: SlimeEvent): void {
    emitSafely(this.#parts.config.onEvent, event);
  }
}
