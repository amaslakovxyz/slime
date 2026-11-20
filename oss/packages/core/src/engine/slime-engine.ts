import type { SlimeConfig } from '../config.js';
import type { SlimeEvent } from '../config/options.js';
import type { Dictionary } from '../dictionary/dictionary.js';
import { SlimeError } from '../errors.js';
import type { Artifact, Generator, SandboxRunner } from '../ports.js';
import { canonicalJSON, requestKey, type HandlerProvenance } from '../request/key.js';
import { literalsInIntent, parseRequest, type InputValues, type ParsedRequest, type SlimeRequest } from '../request/parse.js';
import { checkParamTypes } from '../request/params.js';
import type { SlimeStore } from '../store/types.js';
import { Coalescer } from './coalescer.js';
import { emitSafely } from './events.js';
import { executeArtifact, type Execution } from './execute.js';
import { generateHandler, type GenerationOutcome } from './generate.js';
import { GenerationLimits } from './generation-limits.js';
import { HandlerCache } from './handler-cache.js';
import type { CacheOutcome, HandlerRecord, HandlerSummary, QueryMeta, QueryResult, Slime, SlimeStats } from './types.js';

export interface EngineParts {
  config: SlimeConfig;
  store: SlimeStore;
  runner: SandboxRunner;
  dictionary: Dictionary;
  provenance: HandlerProvenance;
}

interface ResolvedHandler {
  record: HandlerRecord;
  cache: CacheOutcome;
  /** Set on a miss: the generating run already answered this request. */
  firstRun?: Execution;
  generateMs?: number;
}

interface MetaExtras {
  warnings: string[];
  totalMs: number;
}

const LOCKED_MISS = 'Slime is locked: only saved handlers are served, and none matches this request.';
const MS_PRECISION = 100;

export class SlimeEngine implements Slime {
  readonly #parts: EngineParts;
  readonly #cache: HandlerCache;
  readonly #limits: GenerationLimits;
  readonly #generations = new Coalescer<GenerationOutcome>();

  constructor(parts: EngineParts) {
    const { config, store, provenance } = parts;
    this.#parts = parts;
    this.#cache = new HandlerCache({ store, mode: config.mode, provenance, gasWindowMs: config.tiers.gasWindowMs });
    this.#limits = new GenerationLimits({ maxPerHour: config.limits.maxGenerationsPerHour, maxConcurrent: config.limits.maxConcurrentGenerations });
  }

  async query(request: SlimeRequest): Promise<QueryResult> {
    try {
      return await this.#answer(request);
    } catch (error) {
      if (error instanceof SlimeError) this.#emit({ type: 'error', code: error.code, message: error.message });
      throw error;
    }
  }

  handlers(): HandlerSummary[] {
    return this.#cache.summaries();
  }

  stats(): SlimeStats {
    return { mode: this.#parts.config.mode, handlers: this.#cache.countByTier(), generationsThisHour: this.#limits.generationsThisHour, generationsInFlight: this.#limits.inFlight };
  }

  evict(handlerKey: string): Promise<boolean> {
    return this.#cache.evict(handlerKey);
  }

  // Nothing is written in the background before M4 (reviews and promotion).
  async flush(): Promise<void> {}

  async close(): Promise<void> {
    await this.flush();
    await this.#parts.runner.close();
    await this.#parts.store.close?.();
    await this.#parts.config.connector.close();
  }

  async #answer(raw: unknown): Promise<QueryResult> {
    const startedAt = performance.now();
    const request = parseRequest(raw);
    const resolved = await this.#resolve(requestKey(request), request);
    const execution = resolved.firstRun ?? (await this.#runSaved(resolved.record, request.input));
    const warnings = literalsInIntent(request.intent).map(literalWarning);
    return { data: execution.data, meta: this.#meta(resolved, execution, { warnings, totalMs: performance.now() - startedAt }) };
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
      const { config, runner, dictionary, provenance } = this.#parts;
      const deps = { generator, connector: config.connector, runner, limits: config.limits, dictionaryText: dictionary.text, provenance };
      const outcome = await generateHandler(deps, key, request);
      this.#cache.addGas(outcome.record);
      this.#emitGenerated(outcome);
      return outcome;
    } finally {
      releaseSlot();
    }
  }

  async #runSaved(record: HandlerRecord, input: InputValues): Promise<Execution> {
    record.paramTypes = checkParamTypes(record.paramTypes, input);
    const { config, runner } = this.#parts;
    const execution = await executeArtifact({ connector: config.connector, runner, limits: config.limits }, { artifact: record.artifact, output: record.output, input });
    recordRun(record, input, config.tiers.fixturesPerHandler);
    return execution;
  }

  #meta({ record, cache, generateMs }: ResolvedHandler, execution: Execution, { warnings, totalMs }: MetaExtras): QueryMeta {
    const timingsMs = { total: roundMs(totalMs), run: roundMs(execution.runMs), shape: roundMs(execution.shapeMs), ...(generateMs === undefined ? {} : { generate: roundMs(generateMs) }) };
    return { handlerKey: record.key, tier: record.tier, cache, truncated: execution.truncated, timingsMs, warnings, review: record.review, ...this.#generatedCode(record.artifact) };
  }

  // R9, R11: generated code is shown in explore mode only.
  #generatedCode({ sql, shapeJs, assumptions }: Artifact): Pick<QueryMeta, 'sql' | 'shapeJs' | 'assumptions'> {
    if (this.#parts.config.mode === 'locked') return {};
    return { sql, assumptions, ...(shapeJs ? { shapeJs } : {}) };
  }

  #emitGenerated({ record: { key, artifact }, usage }: GenerationOutcome): void {
    const tokens = usage.inputTokens + usage.outputTokens;
    this.#emit({ type: 'generated', handlerKey: key, sql: artifact.sql, assumptions: artifact.assumptions, tokens, ms: usage.ms, ...(artifact.shapeJs ? { shapeJs: artifact.shapeJs } : {}) });
  }

  #emit(event: SlimeEvent): void {
    emitSafely(this.#parts.config.onEvent, event);
  }
}

function recordRun(record: HandlerRecord, input: InputValues, maxFixtures: number): void {
  record.runs++;
  const fixture = canonicalJSON(input);
  const isNewInput = !record.fixtures.some((saved) => canonicalJSON(saved) === fixture);
  if (isNewInput && record.fixtures.length < maxFixtures) record.fixtures.push(structuredClone(input));
}

function literalWarning(label: string): string {
  return `The intent seems to contain ${label}; move the value into input so the handler serves other values too (R7).`;
}

function roundMs(ms: number): number {
  return Math.round(ms * MS_PRECISION) / MS_PRECISION;
}
