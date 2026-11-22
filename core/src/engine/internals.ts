// What build-time tools (@slime-cloud/crystal) need from a running instance, kept
// off the public Slime interface: the engine registers it, core/tooling reads it.
import type { LimitOptions, TierOptions } from '../config/options.js';
import type { HandlerRecord } from '../handler/record.js';
import type { SandboxRunner } from '../sandbox/types.js';
import type { ApiSchema } from '../sources/api/types.js';
import type { Connector } from '../sources/sql/types.js';
import type { Source } from '../sources/types.js';
import type { SlimeStore } from '../stores/types.js';
import type { Slime } from './types.js';

export interface SlimeInternals {
  connector: Connector;
  /** Every source by name, the SQL one included: API steps run through them. */
  sources: Readonly<Record<string, Source>>;
  sqlSourceName: string;
  /** API sources' schemas, as described at startup. */
  apiSchemas: Readonly<Record<string, ApiSchema>>;
  /** The store the instance reads and writes, the default file store included. */
  store: SlimeStore;
  runner: SandboxRunner;
  limits: Readonly<LimitOptions>;
  tiers: Readonly<TierOptions>;
  /** Handlers in memory now. Runs and fixtures grow here between store writes, so these are newer than the store's. */
  liveRecords(): HandlerRecord[];
}

const NOT_AN_ENGINE = 'not a Slime instance made by createSlime()';
const registry = new WeakMap<object, SlimeInternals>();

export function registerInternals(slime: Slime, internals: SlimeInternals): void {
  registry.set(slime, internals);
}

export function slimeInternals(slime: Slime): SlimeInternals {
  const internals = registry.get(slime);
  if (!internals) throw new TypeError(NOT_AN_ENGINE);
  return internals;
}
