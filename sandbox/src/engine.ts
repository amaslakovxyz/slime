import { config } from './config.js';
import type { Connector, SchemaInfo } from './connectors/types.js';
import { SlimeError } from './errors.js';
import {
  artifactKey,
  inputSignature,
  literalWarnings,
  requestFingerprint,
  canonicalJSON,
  crystalKey,
  schemaHashOf,
} from './fingerprint.js';
import type { Artifact, Generator } from './generator.js';
import { promptHashFor } from './prompts.js';
import type { Reviewer } from './review.js';
import {
  MemoryHandlerStore,
  PostgresHandlerStore,
  codeHash,
  type Fixture,
  type HandlerStore,
  type StoredHandler,
} from './store.js';
import { loadCrystals, type LoadedCrystal } from './crystal/loader.js';
import { runShape, warmSandbox } from './sandbox.js';
import { assertReadOnlySql } from './sql-guard.js';
import { assertValidShape, validateAgainstShape, type Shape } from './shape.js';

// Gas: generated recently, kept in a holding area that expires after GAS_WINDOW_MS.
// Liquid: reached GAS_TO_LIQUID_HITS requests inside the window AND passed the
//         background review; kept.
// Crystal: (built last) optimized code shipped as part of the app. Not in this sandbox.
export type Tier = 'gas' | 'liquid' | 'crystal';

// pending: queued or running. approved: may be promoted. rejected: stays Gas (and
// expires) even if popular. failed: the review call itself failed; retried on the
// next hit. skipped: reviews are off (SLIME_REVIEW=off).
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'failed' | 'skipped';

interface ReviewState {
  status: ReviewStatus;
  reviews: number;
  problems: string[];
  ms: number;
  waitMs: number;
  reviewedAt: number | null;
}

export interface QueryRequest {
  intent: string;
  input: Record<string, unknown>;
  output: Shape;
}

interface GenerationStats {
  ms: number; // model time only
  waitMs: number; // provider rate-limit waits (free tiers)
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface Handler {
  id: string;
  fingerprint: string;
  intent: string;
  inputSig: Record<string, string>;
  // Input values of the request that created the handler. Used only to re-run a
  // revised handler against the database; never sent to a model.
  sampleInput: Record<string, unknown>;
  output: Shape;
  artifact: Artifact;
  revision: number;
  history: { artifact: Artifact; rejectedFor: string[] }[];
  review: ReviewState;
  tier: Tier;
  hits: number; // lookups, including ones that later failed
  runs: number; // successful executions with the current code; drives promotion
  errors: number;
  fixtures: Fixture[]; // successful runs on distinct inputs, capped
  persisted: boolean;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number | null;
  generation: GenerationStats;
}

/** Injection points for tests; production uses config. */
export interface EngineDeps {
  generator?: Generator;
  reviewer?: Reviewer | null;
  store?: HandlerStore;
  /** Crystal folder to load (defaults to config.crystalDir). */
  crystalDir?: string;
}

export interface Timings {
  generate: number;
  check: number;
  execute: number;
  shape: number;
  total: number;
}

export interface QueryMeta {
  handlerId: string;
  tier: Tier;
  cache: 'hit' | 'miss' | 'coalesced';
  timingsMs: Timings;
  rowCount: number;
  truncated: boolean;
  sql: string;
  shapeJs: string | null;
  assumptions: string[];
  warnings: string[];
  review: { status: ReviewStatus; revision: number };
  generation?: GenerationStats;
}

interface Execution {
  data: unknown;
  rowCount: number;
  truncated: boolean;
  timings: Omit<Timings, 'total' | 'generate'>;
}


export class Engine {
  private handlers = new Map<string, Handler>();
  private inflight = new Map<string, Promise<Handler>>();
  private generationTimes: number[] = [];
  private slots: number;
  private waiting: (() => void)[] = [];
  // Reviews run one at a time, off the request path, in arrival order.
  private reviewChain: Promise<void> = Promise.resolve();
  private reviewing = new Set<string>();
  // Store writes happen off the request path; tracked so tests and shutdown can await them.
  private pendingWrites = new Set<Promise<void>>();
  private loaded = { liquid: 0, refused: 0 };
  // Crystal handlers by crystalKey(fingerprint, schemaHash): plain code from git, no sandbox.
  private crystals = new Map<string, LoadedCrystal>();
  private crystalReport = { loaded: 0, refused: [] as { key: string; reason: string }[], otherSchema: 0 };

  private constructor(
    private readonly connector: Connector,
    readonly schema: SchemaInfo,
    private readonly schemaHash: string,
    private readonly promptHash: string,
    private readonly generator: Generator | null,
    private readonly reviewer: Reviewer | null,
    private readonly store: HandlerStore,
  ) {
    this.slots = config.maxConcurrentGenerations;
  }

  static async create(connector: Connector, deps: EngineDeps = {}): Promise<Engine> {
    const safety = await connector.safetyCheck();
    if (!safety.ok) {
      throw new Error(`Refusing to start: the database user is not read-only.\n - ${safety.problems.join('\n - ')}`);
    }
    const schema = await connector.describe();
    const schemaHash = schemaHashOf(schema);
    await warmSandbox();

    const store =
      deps.store ??
      (config.metaDatabaseUrl ? new PostgresHandlerStore(config.metaDatabaseUrl, config.metaTable) : new MemoryHandlerStore());
    await store.init();
    // Computed the same way in every mode, so a locked server finds the handlers
    // an explore-mode server saved.
    const promptHash = promptHashFor(config.provider);

    let generator: Generator | null = null;
    let reviewer: Reviewer | null = null;
    // Locked mode never loads a model client, so no model call is possible.
    if (config.mode !== 'locked') {
      if (deps.generator) {
        generator = deps.generator;
        reviewer = deps.reviewer ?? null;
      } else {
        const { createGenerator } = await import('./generators.js');
        ({ generator, reviewer } = await createGenerator(schema));
      }
    }
    const engine = new Engine(connector, schema, schemaHash, promptHash, generator, reviewer, store);
    await engine.loadPersisted();
    if (config.crystal) await engine.loadCrystalFolder(deps.crystalDir ?? config.crystalDir);
    return engine;
  }

  /** Saves batched run counts and waits for queued store writes (used by tests and shutdown). */
  async flush(): Promise<void> {
    clearTimeout(this.runsTimer);
    this.runsTimer = undefined;
    this.flushRuns();
    while (this.pendingWrites.size) await Promise.all([...this.pendingWrites]);
  }

  async close(): Promise<void> {
    await this.flush();
    await this.store.close();
  }

  async query(raw: unknown): Promise<{ data: unknown; meta: QueryMeta }> {
    const started = performance.now();
    const req = parseRequest(raw);
    const inputSig = inputSignature(req.input);
    const fingerprint = requestFingerprint(req.intent, inputSig, req.output);
    const key = artifactKey({ fingerprint, schemaHash: this.schemaHash, promptHash: this.promptHash, model: config.model });
    const warnings = literalWarnings(req.intent);

    // Crystal first: reviewed, equivalence-tested code shipped in git.
    const crystal = this.crystals.get(crystalKey(fingerprint, this.schemaHash));
    if (crystal) return this.serveCrystal(crystal, req, warnings, started);

    let handler = this.lookup(key);
    let cache: QueryMeta['cache'] = 'hit';
    let firstRun: Execution | undefined;

    if (handler) {
      this.recordHit(handler);
    } else {
      if (!this.generator) {
        throw new SlimeError('HANDLER_NOT_FOUND', 'Slime is locked: only handlers generated before locking are served.');
      }
      const pending = this.inflight.get(key);
      if (pending) {
        cache = 'coalesced';
        handler = await pending;
        this.recordHit(handler);
      } else {
        cache = 'miss';
        const generation = this.generate(key, fingerprint, req, inputSig);
        const shared = generation.then((g) => g.handler);
        // Coalesced followers await `shared` and still get the error; this no-op
        // handler only stops a failed generation with no followers from being an
        // unhandled rejection, which would crash the process.
        shared.catch(() => {});
        this.inflight.set(key, shared);
        try {
          const g = await generation;
          handler = g.handler;
          firstRun = g.execution;
        } finally {
          this.inflight.delete(key);
        }
      }
    }

    let execution = firstRun;
    if (!execution) {
      try {
        execution = await this.execute(handler.artifact, handler.output, req.input);
      } catch (err) {
        handler.errors++;
        throw err;
      }
      this.recordSuccess(handler, req.input, execution.data);
    }

    if (handler.review.status === 'rejected') {
      warnings.push(`A background review found problems with this handler: ${handler.review.problems.join(' ')}`);
    }

    const total = performance.now() - started;
    return {
      data: execution.data,
      meta: {
        handlerId: handler.id,
        tier: handler.tier,
        cache,
        timingsMs: round({ generate: cache === 'miss' ? handler.generation.ms : 0, ...execution.timings, total }),
        rowCount: execution.rowCount,
        truncated: execution.truncated,
        sql: handler.artifact.sql,
        shapeJs: handler.artifact.shapeJs,
        assumptions: handler.artifact.assumptions,
        warnings,
        review: { status: handler.review.status, revision: handler.revision },
        ...(cache === 'miss' ? { generation: round(handler.generation) } : {}),
      },
    };
  }

  listHandlers() {
    return [...this.handlers.values()].map((h) => ({
      id: h.id,
      tier: h.tier,
      intent: h.intent,
      hits: h.hits,
      runs: h.runs,
      errors: h.errors,
      recordedRuns: h.fixtures.length,
      saved: h.persisted,
      createdAt: new Date(h.createdAt).toISOString(),
      lastUsedAt: new Date(h.lastUsedAt).toISOString(),
      expiresAt: h.expiresAt ? new Date(h.expiresAt).toISOString() : null,
      sql: h.artifact.sql,
      shapeJs: h.artifact.shapeJs,
      assumptions: h.artifact.assumptions,
      revision: h.revision,
      review: { ...round(h.review), reviewedAt: h.review.reviewedAt ? new Date(h.review.reviewedAt).toISOString() : null },
      previousVersions: h.history,
      generation: round(h.generation),
    }));
  }

  listCrystals() {
    return [...this.crystals.values()].map((c) => ({
      id: c.key,
      tier: 'crystal' as const,
      intent: c.entry.intent,
      file: c.entry.file,
      optimized: c.entry.optimized,
      notes: c.entry.notes,
      sql: c.code.sql,
      shape: c.code.shape,
      from: c.entry.from,
      createdAt: c.entry.createdAt,
    }));
  }

  getHandler(id: string): Handler | undefined {
    for (const h of this.handlers.values()) if (h.id === id) return h;
    return undefined;
  }

  /** Resolves once no review is queued or running (used by the bench). */
  async reviewsSettled(): Promise<void> {
    while (this.reviewing.size) await this.reviewChain;
  }

  evict(id: string): boolean {
    for (const [key, h] of this.handlers) {
      if (h.id === id) return this.handlers.delete(key);
    }
    return false;
  }

  stats() {
    const byTier = { gas: 0, liquid: 0, crystal: 0 };
    const byReview: Record<ReviewStatus, number> = { pending: 0, approved: 0, rejected: 0, failed: 0, skipped: 0 };
    for (const h of this.handlers.values()) {
      byTier[h.tier]++;
      byReview[h.review.status]++;
    }
    return {
      mode: config.mode,
      provider: this.generator ? config.provider : null,
      model: this.generator ? config.model : null,
      reviewModel: this.reviewer?.model ?? null,
      reviews: byReview,
      schemaHash: this.schemaHash,
      promptHash: this.promptHash,
      tables: this.schema.tables.map((t) => t.name),
      handlers: byTier,
      store: { kind: this.store.kind, loadedOnStart: this.loaded.liquid, refusedOnStart: this.loaded.refused },
      crystal: {
        enabled: config.crystal,
        loaded: this.crystalReport.loaded,
        refused: this.crystalReport.refused,
        otherSchema: this.crystalReport.otherSchema,
      },
      generationsLastHour: this.recentGenerations(),
    };
  }

  // ---------------------------------------------------------------------------

  private lookup(key: string): Handler | undefined {
    const handler = this.handlers.get(key);
    if (handler?.tier === 'gas' && handler.expiresAt !== null && Date.now() > handler.expiresAt) {
      this.handlers.delete(key); // Gas that never became Liquid evaporates.
      return undefined;
    }
    return handler;
  }

  private recordHit(handler: Handler) {
    handler.hits++;
    handler.lastUsedAt = Date.now();
    if (handler.review.status === 'failed') this.scheduleReview(handler); // retry a review that errored
  }

  /** A run that passed every check: counts toward promotion and may be recorded. */
  private recordSuccess(handler: Handler, input: Record<string, unknown>, output: unknown) {
    handler.runs++;
    const added = this.recordFixture(handler, input, output);
    this.promoteIfReady(handler);
    if (handler.tier === 'liquid' && handler.persisted) {
      // The saved run count decides when Crystal is built, so it must not lag far
      // behind. A newly recorded run is saved at once; plain count changes are
      // batched every few seconds and on shutdown, not written per request.
      if (added) this.saveRuns(handler);
      else this.markRunsDirty(handler);
    }
  }

  private dirtyRuns = new Set<Handler>();
  private runsTimer: NodeJS.Timeout | undefined;

  private markRunsDirty(handler: Handler) {
    this.dirtyRuns.add(handler);
    this.runsTimer ??= setTimeout(() => {
      this.runsTimer = undefined;
      this.flushRuns();
    }, 5_000).unref();
  }

  private flushRuns() {
    for (const h of this.dirtyRuns) this.saveRuns(h);
  }

  private saveRuns(handler: Handler) {
    this.dirtyRuns.delete(handler);
    this.track(this.store.updateRuns(handler.id, handler.fixtures, handler.runs, new Date(handler.lastUsedAt).toISOString()));
  }

  private recordFixture(handler: Handler, input: Record<string, unknown>, output: unknown): boolean {
    if (handler.fixtures.length >= config.fixturesPerHandler) return false;
    const key = canonicalJSON(input);
    if (handler.fixtures.some((f) => canonicalJSON(f.input) === key)) return false;
    handler.fixtures.push({ input: structuredClone(input), output: structuredClone(output), at: new Date().toISOString() });
    return true;
  }

  /**
   * Gas becomes Liquid only after enough successful runs AND an approved review.
   * Promotion saves the handler, so it survives restarts.
   */
  private promoteIfReady(handler: Handler) {
    const reviewed = handler.review.status === 'approved' || handler.review.status === 'skipped';
    if (handler.tier === 'gas' && reviewed && handler.runs >= config.gasToLiquidHits) {
      handler.tier = 'liquid';
      handler.expiresAt = null;
      this.persist(handler);
    }
  }

  private persist(handler: Handler) {
    const stored: StoredHandler = {
      artifactKey: handler.id,
      fingerprint: handler.fingerprint,
      intent: handler.intent,
      inputSig: handler.inputSig,
      output: handler.output,
      artifact: handler.artifact,
      codeHash: codeHash(handler.artifact),
      schemaHash: this.schemaHash,
      promptHash: this.promptHash,
      model: config.model,
      revision: handler.revision,
      review: { status: handler.review.status, reviews: handler.review.reviews, problems: handler.review.problems },
      history: handler.history,
      fixtures: handler.fixtures,
      runs: handler.runs,
      createdAt: new Date(handler.createdAt).toISOString(),
      promotedAt: new Date().toISOString(),
      lastUsedAt: new Date(handler.lastUsedAt).toISOString(),
    };
    this.track(this.store.saveLiquid(stored).then(() => void (handler.persisted = true)));
  }

  private track(write: Promise<void>) {
    const tracked = write
      .catch((err) => console.error(`[slime] store write failed: ${(err as Error).message}`))
      .finally(() => this.pendingWrites.delete(tracked));
    this.pendingWrites.add(tracked);
  }

  /** Loads the Crystal folder. Bad entries are refused and reported, never fatal. */
  private async loadCrystalFolder(dir: string) {
    const { loaded, refused, ignored } = await loadCrystals(dir, this.schemaHash);
    for (const c of loaded) this.crystals.set(c.key, c);
    this.crystalReport = { loaded: loaded.length, refused, otherSchema: ignored };
    for (const r of refused) console.error(`[slime] refusing Crystal ${r.key}: ${r.reason}`);
  }

  /** Crystal: the SQL still runs as the read-only user; the shaping is a plain function call. */
  private async serveCrystal(
    crystal: LoadedCrystal,
    req: QueryRequest,
    warnings: string[],
    started: number,
  ): Promise<{ data: unknown; meta: QueryMeta }> {
    const run = await this.connector.run(crystal.code.sql, crystal.code.params.map((name) => req.input[name] ?? null));
    let data: unknown = run.rows;
    let shapeMs = 0;
    if (crystal.shape) {
      const t = performance.now();
      try {
        data = crystal.shape(run.rows, req.input);
      } catch (err) {
        throw new SlimeError('SANDBOX_ERROR', `Crystal shape function threw: ${(err as Error).message}`);
      }
      shapeMs = performance.now() - t;
    }
    const mismatches = validateAgainstShape(req.output, data);
    if (mismatches.length) {
      throw new SlimeError('SHAPE_MISMATCH', `Result does not match the requested output: ${mismatches.join('; ')}`, false, {
        mismatches,
      });
    }
    return {
      data,
      meta: {
        handlerId: crystal.key,
        tier: 'crystal',
        cache: 'hit',
        timingsMs: round({ generate: 0, check: 0, execute: run.ms, shape: shapeMs, total: performance.now() - started }),
        rowCount: run.rows.length,
        truncated: run.truncated,
        sql: crystal.code.sql,
        shapeJs: crystal.code.shape,
        assumptions: [],
        warnings,
        review: { status: 'approved', revision: crystal.entry.from.revision },
      },
    };
  }

  /** Loads saved Liquid handlers for the current schema, prompt and model. */
  private async loadPersisted() {
    const rows = await this.store.loadLiquid({ schemaHash: this.schemaHash, promptHash: this.promptHash, model: config.model });
    for (const row of rows) {
      // The stored code must be exactly the code that was reviewed and promoted.
      if (codeHash(row.artifact) !== row.codeHash) {
        this.loaded.refused++;
        console.error(`[slime] refusing saved handler ${row.artifactKey}: its code does not match the recorded hash`);
        continue;
      }
      this.handlers.set(row.artifactKey, {
        id: row.artifactKey,
        fingerprint: row.fingerprint,
        intent: row.intent,
        inputSig: row.inputSig,
        sampleInput: row.fixtures[0]?.input ?? {},
        output: row.output,
        artifact: row.artifact,
        revision: row.revision,
        history: row.history,
        review: {
          status: row.review.status as ReviewStatus,
          reviews: row.review.reviews,
          problems: row.review.problems,
          ms: 0,
          waitMs: 0,
          reviewedAt: null,
        },
        tier: 'liquid',
        hits: row.runs,
        runs: row.runs,
        errors: 0,
        fixtures: row.fixtures,
        persisted: true,
        createdAt: Date.parse(row.createdAt),
        lastUsedAt: Date.parse(row.lastUsedAt),
        expiresAt: null,
        generation: { ms: 0, waitMs: 0, attempts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      });
      this.loaded.liquid++;
    }
  }

  private scheduleReview(handler: Handler) {
    if (!this.reviewer || this.reviewing.has(handler.id)) return;
    this.reviewing.add(handler.id);
    handler.review.status = 'pending';
    this.reviewChain = this.reviewChain.then(() => this.runReview(handler));
  }

  // Never throws: the outcome is recorded on the handler.
  private async runReview(handler: Handler): Promise<void> {
    try {
      for (;;) {
        handler.review.reviews++;
        const r = await this.reviewer!.review(
          { intent: handler.intent, inputSig: handler.inputSig, output: handler.output, artifact: handler.artifact },
          config.reviewTimeoutMs,
        );
        handler.review.ms += r.ms;
        handler.review.waitMs += r.waitMs;
        handler.review.reviewedAt = Date.now();
        handler.review.problems = r.problems;
        if (r.verdict === 'approve') {
          handler.review.status = 'approved';
          this.promoteIfReady(handler);
          return;
        }
        if (handler.review.reviews >= config.maxReviews || !(await this.revise(handler, r.problems))) {
          handler.review.status = 'rejected';
          return;
        }
      }
    } catch (err) {
      handler.review.status = 'failed';
      handler.review.problems = [`review failed: ${(err as Error).message}`];
    } finally {
      this.reviewing.delete(handler.id);
    }
  }

  /**
   * Regenerates a rejected handler with the reviewer's notes. The revision replaces
   * the old code only if it passes the same checks against the database; the old
   * version is kept in `history`, and responses expose the revision number.
   */
  private async revise(handler: Handler, problems: string[]): Promise<boolean> {
    let previous = { artifact: handler.artifact, error: `A reviewer rejected this handler: ${problems.join(' ')}` };
    // Same repair budget as a normal generation: a revision that fails a check gets
    // the error back once, so a small slip (e.g. an unquoted alias) doesn't sink it.
    for (let attempt = 1; attempt <= 1 + config.maxRepairs; attempt++) {
      this.generationTimes.push(Date.now());
      const gen = await this.generator!.generate(
        { intent: handler.intent, inputSig: handler.inputSig, output: handler.output, previous },
        config.generationBudgetMs,
      );
      const candidate = gen.artifact;
      if (candidate.unsatisfiable) {
        handler.review.problems = [...problems, `revision gave up: ${candidate.unsatisfiable}`];
        return false;
      }
      let checkRun: Execution;
      try {
        lintArtifact(candidate, handler.sampleInput);
        await this.connector.check(candidate.sql, bindParams(candidate, handler.sampleInput));
        checkRun = await this.execute(candidate, handler.output, handler.sampleInput);
      } catch (err) {
        const message = (err as Error).message;
        handler.review.problems = [...problems, `revision failed checks: ${message}`];
        previous = {
          artifact: candidate,
          error: `${previous.error} Your revision then failed a check: ${message}`,
        };
        continue;
      }
      handler.history.push({ artifact: handler.artifact, rejectedFor: problems });
      handler.artifact = candidate;
      handler.revision++;
      // Runs and recorded runs belonged to the old code; the new code starts over
      // from its own check run.
      handler.runs = 1;
      handler.fixtures = [];
      this.recordFixture(handler, handler.sampleInput, checkRun.data);
      return true;
    }
    return false;
  }

  private async generate(
    key: string,
    fingerprint: string,
    req: QueryRequest,
    inputSig: Record<string, string>,
  ): Promise<{ handler: Handler; execution: Execution }> {
    if (this.recentGenerations() >= config.maxGenerationsPerHour) {
      throw new SlimeError('GENERATION_RATE_LIMITED', `Generation cap of ${config.maxGenerationsPerHour}/hour reached.`, true);
    }
    await this.acquireSlot();
    try {
      this.generationTimes.push(Date.now());
      let deadline = Date.now() + config.generationBudgetMs;
      const stats: GenerationStats = { ms: 0, waitMs: 0, attempts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      let previous: { artifact: Artifact; error: string } | undefined;
      let lastError: SlimeError | undefined;

      for (let attempt = 1; attempt <= 1 + config.maxRepairs; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining < 1_000) break;
        const gen = await this.generator!.generate({ intent: req.intent, inputSig, output: req.output, previous }, remaining);
        stats.ms += gen.ms;
        stats.waitMs += gen.waitMs;
        deadline += gen.waitMs; // rate-limit waits don't count against the generation budget
        stats.attempts = attempt;
        stats.inputTokens += gen.inputTokens;
        stats.outputTokens += gen.outputTokens;
        stats.cacheReadTokens += gen.cacheReadTokens;
        const artifact = gen.artifact;

        if (artifact.unsatisfiable) {
          const writeLike = /\b(writ|delet|updat|insert|modif|chang|remov|creat)/i.test(artifact.unsatisfiable);
          throw new SlimeError(writeLike ? 'WRITE_REFUSED' : 'INTENT_UNSATISFIABLE', artifact.unsatisfiable, false, {
            enforcedBy: 'model',
          });
        }

        try {
          lintArtifact(artifact, req.input);
          const params = bindParams(artifact, req.input);
          const check = await this.connector.check(artifact.sql, params);
          const execution = await this.execute(artifact, req.output, req.input);
          execution.timings.check = check.ms;
          const now = Date.now();
          const handler: Handler = {
            id: key,
            fingerprint,
            intent: req.intent,
            inputSig,
            sampleInput: req.input,
            output: req.output,
            artifact,
            revision: 0,
            history: [],
            review: {
              status: this.reviewer ? 'pending' : 'skipped',
              reviews: 0,
              problems: [],
              ms: 0,
              waitMs: 0,
              reviewedAt: null,
            },
            tier: 'gas',
            hits: 1,
            runs: 1, // the generating request's own run passed every check
            errors: 0,
            fixtures: [{ input: structuredClone(req.input), output: structuredClone(execution.data), at: new Date(now).toISOString() }],
            persisted: false,
            createdAt: now,
            lastUsedAt: now,
            expiresAt: now + config.gasWindowMs,
            generation: stats,
          };
          // Cached only after it ran successfully and matched the requested shape.
          this.handlers.set(key, handler);
          this.promoteIfReady(handler);
          this.scheduleReview(handler); // runs in the background; this response doesn't wait
          return { handler, execution };
        } catch (err) {
          const e = err instanceof SlimeError ? err : new SlimeError('QUERY_ERROR', String(err));
          // The database or lint refusing access/writes is final: retrying won't make it allowed.
          if (e.code === 'FIELD_NOT_EXPOSED' || e.code === 'WRITE_REFUSED') throw e;
          lastError = e;
          previous = { artifact, error: `${e.code}: ${e.message}` };
        }
      }
      throw lastError ?? new SlimeError('GENERATION_TIMEOUT', 'Ran out of generation time budget.', true);
    } finally {
      this.releaseSlot();
    }
  }

  private async execute(artifact: Artifact, output: Shape, input: Record<string, unknown>): Promise<Execution> {
    const run = await this.connector.run(artifact.sql, bindParams(artifact, input));
    let data: unknown = run.rows;
    let shapeMs = 0;
    if (artifact.shapeJs) {
      const shaped = await runShape(artifact.shapeJs, run.rows, input);
      data = shaped.data;
      shapeMs = shaped.ms;
    }
    const mismatches = validateAgainstShape(output, data);
    if (mismatches.length) {
      throw new SlimeError('SHAPE_MISMATCH', `Result does not match the requested output: ${mismatches.join('; ')}`, false, {
        mismatches,
      });
    }
    return { data, rowCount: run.rows.length, truncated: run.truncated, timings: { check: 0, execute: run.ms, shape: shapeMs } };
  }

  private recentGenerations(): number {
    const cutoff = Date.now() - 60 * 60 * 1000;
    this.generationTimes = this.generationTimes.filter((t) => t > cutoff);
    return this.generationTimes.length;
  }

  private async acquireSlot() {
    if (this.slots > 0) {
      this.slots--;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private releaseSlot() {
    const next = this.waiting.shift();
    if (next) next();
    else this.slots++;
  }
}

// -----------------------------------------------------------------------------

function parseRequest(raw: unknown): QueryRequest {
  if (!raw || typeof raw !== 'object') throw new SlimeError('INVALID_REQUEST', 'Body must be a JSON object.');
  const { intent, input = {}, output } = raw as Record<string, unknown>;
  if (typeof intent !== 'string' || !intent.trim()) throw new SlimeError('INVALID_REQUEST', '"intent" must be a non-empty string.');
  if (intent.length > 500) throw new SlimeError('INVALID_REQUEST', '"intent" must be at most 500 characters.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SlimeError('INVALID_REQUEST', '"input" must be an object of parameter values.');
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 20) throw new SlimeError('INVALID_REQUEST', '"input" may have at most 20 keys.');
  for (const [k, v] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new SlimeError('INVALID_REQUEST', `Input key "${k}" is not a valid name.`);
    const scalar = (x: unknown) => x === null || ['string', 'number', 'boolean'].includes(typeof x);
    if (!(scalar(v) || (Array.isArray(v) && v.every(scalar)))) {
      throw new SlimeError('INVALID_REQUEST', `Input "${k}" must be a string, number, boolean, null, or a list of those.`);
    }
  }
  if (output === undefined) throw new SlimeError('INVALID_REQUEST', '"output" (the JSON shape you want back) is required.');
  assertValidShape(output);
  return { intent, input: input as Record<string, unknown>, output };
}

/** Static checks on generated code before it touches the database. */
export function lintArtifact(artifact: Artifact, input: Record<string, unknown>) {
  assertReadOnlySql(artifact.sql);
  const used = new Set([...artifact.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  const highest = Math.max(0, ...used);
  if (highest > artifact.params.length) {
    throw new SlimeError('INVALID_HANDLER', `SQL uses $${highest} but only ${artifact.params.length} params are mapped.`);
  }
  artifact.params.forEach((name, i) => {
    if (!(name in input)) throw new SlimeError('INVALID_HANDLER', `Param $${i + 1} maps to "${name}", which is not an input key.`);
    if (!used.has(i + 1)) throw new SlimeError('INVALID_HANDLER', `Param $${i + 1} ("${name}") is mapped but never used in the SQL.`);
  });
  // The model never sees input values, so a value appearing in the code means it
  // was copied from the intent: the handler would return wrong data for other values.
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > 2) {
      if (artifact.sql.includes(value) || artifact.shapeJs?.includes(value)) {
        throw new SlimeError('INVALID_HANDLER', `The value of input "${name}" is hardcoded in the handler; use $n / input.${name}.`);
      }
    }
  }
}

function bindParams(artifact: Artifact, input: Record<string, unknown>): unknown[] {
  return artifact.params.map((name) => input[name] ?? null);
}

function round<T extends object>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v]),
  ) as T;
}
