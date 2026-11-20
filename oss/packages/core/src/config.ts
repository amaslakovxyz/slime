// SlimeConfig: everything core needs, passed in by the app (PLAN.md C4).
// Core never reads process.env or .env; the app decides where each value
// comes from. The constructor fills defaults, reports every problem at once,
// and the result is immutable. config.with({...}) returns a changed copy.
import { SlimeConfigError } from './errors.js';
import type { Connector, Generator, Reviewer } from './ports.js';
import type { SlimeStore } from './store/types.js';

export interface TierOptions {
  /** Successful runs inside the Gas window before a handler may become Liquid. */
  gasToLiquidRuns: number;
  /** How long a Gas handler lives without being promoted. */
  gasWindowMs: number;
  /** Reviews per handler, counting re-reviews after a rejected revision. */
  maxReviews: number;
  /** Successful runs on distinct inputs kept per handler, for Crystal's equivalence test. */
  fixturesPerHandler: number;
}

export interface LimitOptions {
  /** Regeneration attempts after a generated handler fails its checks. */
  maxRepairs: number;
  /** Total model time allowed for one new request, repairs included. */
  generationBudgetMs: number;
  reviewTimeoutMs: number;
  maxConcurrentGenerations: number;
  maxGenerationsPerHour: number;
  statementTimeoutMs: number;
  /** Rows a query may return; more are cut and meta.truncated is set. */
  rowCap: number;
  /** Planner cost above which a query is refused before it runs. */
  maxQueryCost: number;
  shapeTimeoutMs: number;
  shapeMemoryBytes: number;
}

/** Crystal handlers imported from the app's own code (C10). Its exact shape arrives with M5. */
export type CrystalRegistry = Readonly<Record<string, unknown>>;

/** Something that happened inside core (C11, PLAN.md §5). `generated` carries the code so a dev setup can print it (R9). */
export type SlimeEvent =
  | { type: 'generated'; handlerKey: string; sql: string; shapeJs?: string; assumptions: string[]; tokens: number; ms: number }
  | { type: 'reviewed'; handlerKey: string; verdict: 'approved' | 'rejected'; notes: string }
  | { type: 'promoted'; handlerKey: string; tier: 'liquid' }
  | { type: 'warning'; message: string }
  | { type: 'error'; code: string; message: string };

export interface SlimeOptions {
  /** Where data comes from. Required. */
  connector: Connector;
  /** Writes new handlers. Leave out for locked mode: only saved handlers are served (C6). */
  generator?: Generator;
  /** Reviews Gas handlers before they may become Liquid. Leave out to skip reviews. */
  reviewer?: Reviewer;
  /** Where Slime keeps its own state: any SlimeStore. Omitted: createSlime() uses the file store in ./.slime (C14, §4.7). */
  store?: SlimeStore;
  /** Crystal handlers, or false/omitted for none. */
  crystal?: CrystalRegistry | false;
  /** What the app's words mean, for example { revenue: "sum of paid invoices, in cents" }. */
  glossary?: Record<string, string>;
  /** Extra rules for generated SQL, added to the dictionary (D2). */
  rules?: string[];
  tiers?: Partial<TierOptions>;
  limits?: Partial<LimitOptions>;
  onEvent?: (event: SlimeEvent) => void;
}

export const DEFAULT_TIERS: Readonly<TierOptions> = Object.freeze({
  gasToLiquidRuns: 3,
  gasWindowMs: 60 * 60 * 1000,
  maxReviews: 2,
  fixturesPerHandler: 5,
});

export const DEFAULT_LIMITS: Readonly<LimitOptions> = Object.freeze({
  maxRepairs: 1,
  generationBudgetMs: 25_000,
  reviewTimeoutMs: 60_000,
  maxConcurrentGenerations: 2,
  maxGenerationsPerHour: 200,
  statementTimeoutMs: 2_000,
  rowCap: 1_000,
  maxQueryCost: 1_000_000,
  shapeTimeoutMs: 200,
  shapeMemoryBytes: 32 * 1024 * 1024,
});

const OPTION_KEYS = ['connector', 'generator', 'reviewer', 'store', 'crystal', 'glossary', 'rules', 'tiers', 'limits', 'onEvent'];
// Smallest allowed value per numeric option; every one of them must be an integer except maxQueryCost.
const TIER_MIN: Record<keyof TierOptions, number> = { gasToLiquidRuns: 1, gasWindowMs: 1, maxReviews: 1, fixturesPerHandler: 0 };
const LIMIT_MIN: Record<keyof LimitOptions, number> = {
  maxRepairs: 0,
  generationBudgetMs: 1,
  reviewTimeoutMs: 1,
  maxConcurrentGenerations: 1,
  maxGenerationsPerHour: 1,
  statementTimeoutMs: 1,
  rowCap: 1,
  maxQueryCost: 1,
  shapeTimeoutMs: 1,
  shapeMemoryBytes: 1024 * 1024,
};

export class SlimeConfig {
  readonly connector: Connector;
  readonly generator: Generator | undefined;
  readonly reviewer: Reviewer | undefined;
  /** The app's store, or undefined for the default file store, which createSlime() builds (M2). */
  readonly store: SlimeStore | undefined;
  readonly crystal: CrystalRegistry | false;
  readonly glossary: Readonly<Record<string, string>>;
  readonly rules: readonly string[];
  readonly tiers: Readonly<TierOptions>;
  readonly limits: Readonly<LimitOptions>;
  readonly onEvent: (event: SlimeEvent) => void;
  /** 'locked' when there is no generator: no model call is possible (C6). */
  readonly mode: 'explore' | 'locked';

  readonly #options: SlimeOptions;

  constructor(options: SlimeOptions) {
    const problems = validate(options);
    if (problems.length) throw new SlimeConfigError(problems);

    this.#options = { ...options };
    this.connector = options.connector;
    this.generator = options.generator;
    this.reviewer = options.reviewer;
    // A store is an object with behavior and state, so it is used as given, not copied.
    this.store = options.store;
    this.crystal = options.crystal ? Object.freeze({ ...options.crystal }) : false;
    this.glossary = Object.freeze({ ...options.glossary });
    this.rules = Object.freeze([...(options.rules ?? [])]);
    this.tiers = Object.freeze({ ...DEFAULT_TIERS, ...options.tiers });
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    this.onEvent = options.onEvent ?? (() => {});
    this.mode = options.generator ? 'explore' : 'locked';
    Object.freeze(this);
  }

  /**
   * A copy with some options replaced. `tiers` and `limits` are merged key by
   * key; every other option is replaced whole. Set an option to undefined to
   * remove it (for example `generator: undefined` for a locked copy).
   */
  with(overrides: Partial<{ [K in keyof SlimeOptions]: SlimeOptions[K] | undefined }>): SlimeConfig {
    const next: Record<string, unknown> = { ...this.#options, ...overrides };
    next.tiers = { ...this.#options.tiers, ...overrides.tiers };
    next.limits = { ...this.#options.limits, ...overrides.limits };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    return new SlimeConfig(next as unknown as SlimeOptions);
  }
}

function validate(options: unknown): string[] {
  if (!isPlainObject(options)) return ['the config must be an object, for example new SlimeConfig({ connector })'];
  const problems: string[] = [];
  const o = options;

  const unknown = Object.keys(o).filter((k) => !OPTION_KEYS.includes(k));
  if (unknown.length) problems.push(`unknown option${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} (allowed: ${OPTION_KEYS.join(', ')})`);

  if (o.connector === undefined) problems.push('connector is required: it tells Slime where the data comes from');
  else problems.push(...missingMethods('connector', o.connector, ['describe', 'check', 'run', 'safetyCheck', 'close']));

  if (o.generator !== undefined) {
    problems.push(...missingMethods('generator', o.generator, ['generate']));
    problems.push(...missingStrings('generator', o.generator, ['model', 'promptHash']));
  }
  if (o.reviewer !== undefined) {
    problems.push(...missingMethods('reviewer', o.reviewer, ['review']));
    problems.push(...missingStrings('reviewer', o.reviewer, ['model']));
    if (o.generator === undefined) problems.push('reviewer is set but generator is not: without a generator (locked mode) nothing is ever reviewed');
  }

  if (o.store !== undefined) problems.push(...missingMethods('store', o.store, ['get', 'put', 'list', 'delete']));

  if (o.crystal !== undefined && o.crystal !== false && !isPlainObject(o.crystal)) {
    problems.push('crystal must be the imported Crystal registry, or false');
  }

  if (o.glossary !== undefined) {
    if (!isPlainObject(o.glossary)) problems.push('glossary must be an object of { word: "what it means" }');
    else {
      for (const [word, meaning] of Object.entries(o.glossary)) {
        if (!word.trim() || typeof meaning !== 'string' || !meaning.trim()) problems.push(`glossary.${word || '""'} must be a non-empty description`);
      }
    }
  }

  if (o.rules !== undefined) {
    if (!Array.isArray(o.rules) || o.rules.some((r) => typeof r !== 'string' || !r.trim())) {
      problems.push('rules must be a list of non-empty strings');
    }
  }

  problems.push(...validateNumbers('tiers', o.tiers, TIER_MIN, []));
  problems.push(...validateNumbers('limits', o.limits, LIMIT_MIN, ['maxQueryCost']));

  if (o.onEvent !== undefined && typeof o.onEvent !== 'function') problems.push('onEvent must be a function');
  return problems;
}

function validateNumbers(name: string, value: unknown, min: Record<string, number>, fractional: string[]): string[] {
  if (value === undefined) return [];
  if (!isPlainObject(value)) return [`${name} must be an object`];
  const problems: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    const lowest = min[key];
    if (lowest === undefined) {
      problems.push(`unknown option ${name}.${key} (allowed: ${Object.keys(min).join(', ')})`);
      continue;
    }
    const isNumber = typeof v === 'number' && Number.isFinite(v) && (fractional.includes(key) || Number.isInteger(v));
    if (!isNumber || (v as number) < lowest) {
      problems.push(`${name}.${key} must be ${fractional.includes(key) ? 'a number' : 'an integer'} of at least ${lowest}`);
    }
  }
  return problems;
}

function missingMethods(name: string, value: unknown, methods: string[]): string[] {
  if (!value || typeof value !== 'object') return [`${name} must be an object with ${methods.join(', ')}`];
  const missing = methods.filter((m) => typeof (value as Record<string, unknown>)[m] !== 'function');
  return missing.length ? [`${name} is missing ${missing.length > 1 ? 'methods' : 'method'} ${missing.join(', ')}`] : [];
}

function missingStrings(name: string, value: unknown, keys: string[]): string[] {
  if (!value || typeof value !== 'object') return [];
  return keys
    .filter((k) => {
      const v = (value as Record<string, unknown>)[k];
      return typeof v !== 'string' || !v.trim();
    })
    .map((k) => `${name}.${k} must be a non-empty string`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
