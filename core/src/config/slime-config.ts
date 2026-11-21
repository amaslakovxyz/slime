// The app passes everything core needs; core never reads process.env or .env (C4).
import { DEFAULT_LIMITS, DEFAULT_TIERS } from './defaults.js';
import type { CrystalRegistry, LimitOptions, SlimeEvent, SlimeMode, SlimeOptions, TierOptions } from './options.js';
import { configProblems } from './validate.js';
import { SlimeConfigError } from '../shared/errors.js';
import type { Connector, Generator, Reviewer } from '../ports.js';
import type { SlimeStore } from '../stores/types.js';

export { DEFAULT_LIMITS, DEFAULT_TIERS } from './defaults.js';
export type {
  CrystalRegistry,
  ErrorEvent,
  GeneratedEvent,
  LimitOptions,
  PromotedEvent,
  ReviewedEvent,
  SlimeEvent,
  SlimeMode,
  SlimeOptions,
  TierOptions,
  WarningEvent,
} from './options.js';

/** Setting an option to undefined removes it. */
export type SlimeOptionOverrides = { [Key in keyof SlimeOptions]?: SlimeOptions[Key] | undefined };

const ignoreEvent = (): void => {};

export class SlimeConfig {
  readonly connector: Connector;
  readonly generator: Generator | undefined;
  readonly reviewer: Reviewer | undefined;
  /** undefined: createSlime() builds the default file store. */
  readonly store: SlimeStore | undefined;
  readonly crystal: CrystalRegistry | false;
  readonly glossary: Readonly<Record<string, string>>;
  readonly rules: readonly string[];
  readonly tiers: Readonly<TierOptions>;
  readonly limits: Readonly<LimitOptions>;
  readonly onEvent: (event: SlimeEvent) => void;
  readonly mode: SlimeMode;

  readonly #options: SlimeOptions;

  constructor(options: SlimeOptions) {
    const problems = configProblems(options);
    if (problems.length > 0) throw new SlimeConfigError(problems);

    this.#options = { ...options };
    this.connector = options.connector;
    this.generator = options.generator;
    this.reviewer = options.reviewer;
    // Not copied: a store has behavior and state.
    this.store = options.store;
    this.crystal = options.crystal ? Object.freeze({ ...options.crystal }) : false;
    this.glossary = Object.freeze({ ...options.glossary });
    this.rules = Object.freeze([...(options.rules ?? [])]);
    this.tiers = Object.freeze({ ...DEFAULT_TIERS, ...options.tiers });
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    this.onEvent = options.onEvent ?? ignoreEvent;
    this.mode = options.generator ? 'explore' : 'locked';
    Object.freeze(this);
  }

  /** `tiers` and `limits` are merged key by key; every other option is replaced whole. */
  with(overrides: SlimeOptionOverrides): SlimeConfig {
    const merged: Record<string, unknown> = {
      ...this.#options,
      ...overrides,
      tiers: { ...this.#options.tiers, ...overrides.tiers },
      limits: { ...this.#options.limits, ...overrides.limits },
    };
    return new SlimeConfig(withoutUndefined(merged) as unknown as SlimeOptions);
  }
}

function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
