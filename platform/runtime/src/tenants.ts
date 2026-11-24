// The Lambda's endpoints: settings from SSM, one engine per endpoint, at most
// `maxEntries` per instance (least recently used goes first).
//
// Settings are re-read at most once per `ttlMs` per endpoint (GetParametersByPath
// on /slime/endpoints/<id>/, the shared prefix with the same TTL, and an S3 HEAD of
// the Crystal manifest). What changed decides the cost:
//   auth part   (SLIME_API_KEY, CRYSTAL_TOKENS)  swapped into the cached entry; the
//               engine, its Gas handlers, counters and Postgres pool stay
//   engine part (every other value, the shared values, the manifest ETag)  the
//               engine is rebuilt on its next use
// An id with no parameters is remembered as missing for the TTL, so unknown ids
// cost one SSM call per TTL, and malformed ids cost none. An engine that goes
// (evicted, replaced, reloaded, endpoint deleted) is flushed, its live run counts
// saved, then closed.
//
// The env object an engine is built from is the Lambda env, then the shared
// parameters, then the endpoint's, then SLIME_TENANT_ID. Nothing is ever written to
// process.env: endpoints share this process.
//
// Each endpoint's requests feed is also reachable without its engine (Tenant.feed):
// it lives in the handler store, so the Requests log stays readable, and records
// refused requests, while the endpoint's database is down.
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { GetParametersByPathCommand, type GetParametersByPathCommandOutput } from '@aws-sdk/client-ssm';
import type { SandboxRunner } from '@slime-cloud/core';
import { parseCrystalTokens } from './auth.js';
import type { Env } from './config.js';
import type { CrystalLoad, CrystalStore } from './crystal-store.js';
import { endpointRuntime, startupErrorMessage, type EndpointDeps, type EndpointRuntime, type LogLine } from './endpoint-runtime.js';
import { StoredRequests } from './events.js';
import { DynamoSlimeStore, type DocClient } from './store-dynamodb.js';
import { UsageMeter, type UsageClient } from './usage.js';

export const ENDPOINT_ID = /^ep-[0-9a-f]{10}$/;
export const ENDPOINTS_SSM_PREFIX = '/slime/endpoints/';

const AUTH_NAMES = ['SLIME_API_KEY', 'CRYSTAL_TOKENS'];
/** An engine that goes may still be finishing a review; past this the request goes on and the close continues. */
const DEFAULT_RETIRE_LIMIT_MS = 5_000;
/** Unknown ids remembered per instance; past this, expired and then oldest entries go. */
const MISSING_MAX = 1_000;

/** Parameter path -> env var name: the last path segment. */
export function parameterName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The slice of SSMClient the cache uses; tests pass a fake. */
export interface SsmPort {
  send(command: GetParametersByPathCommand): Promise<GetParametersByPathCommandOutput>;
}

export interface TenantCacheOptions {
  ssm: SsmPort;
  crystals: CrystalStore;
  /** The Lambda's own env (tables, bucket, limits); endpoint settings are layered on a copy. */
  baseEnv: Env;
  sharedPrefix: string;
  maxEntries: number;
  ttlMs: number;
  /** One QuickJS pool for every endpoint in the process. */
  runner: SandboxRunner;
  now?: () => number;
  retireLimitMs?: number;
  /** Builds one endpoint's runtime; tests wrap it to pass fakes. */
  build?: (env: Env, deps: EndpointDeps) => Promise<EndpointRuntime>;
  /** The handler store's client for Tenant.feed; tests pass a fake. */
  storeClient?: DocClient;
  /** The usage table's client for the feed's total; tests pass a fake. */
  usageClient?: UsageClient;
  log?: (line: LogLine) => void;
}

/** One endpoint as the router sees it. */
export interface Tenant {
  readonly id: string;
  readonly apiKey: string | undefined;
  readonly crystalTokens: Readonly<Record<string, string>>;
  /** The endpoint's engine, built on first use and rebuilt when its settings changed; throws when it cannot start. */
  runtime(): Promise<EndpointRuntime>;
  /** The endpoint's requests feed in its store: no engine, so no database connection. */
  feed(): StoredRequests;
}

type Values = Record<string, string>;

interface Engine {
  runtime: EndpointRuntime;
  fingerprint: string;
}

class Entry implements Tenant {
  apiKey: string | undefined;
  crystalTokens: Readonly<Record<string, string>> = {};
  checkedAt = 0;
  own: Values = {};
  shared: Values = {};
  etag: string | undefined;
  engine: Engine | undefined;
  building: Promise<EndpointRuntime> | undefined;
  storedFeed: StoredRequests | undefined;
  isDropped = false;

  constructor(
    readonly id: string,
    readonly runtime: () => Promise<EndpointRuntime>,
    readonly feed: () => StoredRequests,
  ) {}

  /** Applies freshly read settings; the auth part takes effect at once, without touching the engine. */
  update(own: Values, shared: Values, etag: string | undefined, now: number): void {
    this.own = own;
    this.shared = shared;
    this.etag = etag;
    this.checkedAt = now;
    this.apiKey = own.SLIME_API_KEY;
    this.crystalTokens = parseCrystalTokens(own.CRYSTAL_TOKENS);
  }

  /** Everything the engine is built from, except the auth part. */
  engineFingerprint(): string {
    const engineOwn = Object.entries(this.own).filter(([name]) => !AUTH_NAMES.includes(name));
    const sorted = (entries: [string, string][]) => entries.sort(([a], [b]) => a.localeCompare(b));
    const text = JSON.stringify([sorted(engineOwn), sorted(Object.entries(this.shared)), this.etag ?? null]);
    return createHash('sha256').update(text).digest('hex');
  }
}

export class TenantCache {
  readonly #options: TenantCacheOptions;
  readonly #now: () => number;
  readonly #build: (env: Env, deps: EndpointDeps) => Promise<EndpointRuntime>;
  readonly #log: (line: LogLine) => void;
  /** Insertion order is recency: the first entry is the least recently used. */
  readonly #entries = new Map<string, Entry>();
  readonly #missingUntil = new Map<string, number>();
  readonly #refreshing = new Map<string, Promise<Entry | undefined>>();
  #shared: { values: Values; readAt: number } | undefined;
  #sharedReading: Promise<Values> | undefined;

  constructor(options: TenantCacheOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#build = options.build ?? endpointRuntime;
    this.#log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  }

  /** The endpoint, or undefined when the id is malformed or has no settings. */
  async get(id: string): Promise<Tenant | undefined> {
    if (!ENDPOINT_ID.test(id)) return undefined;
    const now = this.#now();
    const missingUntil = this.#missingUntil.get(id);
    if (missingUntil !== undefined && now < missingUntil) return undefined;
    const entry = this.#entries.get(id);
    if (entry && now - entry.checkedAt < this.#options.ttlMs) {
      this.#touch(entry);
      return entry;
    }
    let refreshing = this.#refreshing.get(id);
    if (!refreshing) {
      refreshing = this.#refresh(id).finally(() => this.#refreshing.delete(id));
      this.#refreshing.set(id, refreshing);
    }
    if (!entry) return refreshing;
    // A settings check that fails (SSM throttled, say by someone probing random ids) must not
    // take down an endpoint this instance already serves: keep the known settings, try again later.
    return refreshing.catch((err: unknown) => {
      this.#log({ warning: `Settings check failed; serving cached settings: ${(err as Error).message}`, endpointId: id });
      entry.checkedAt = this.#now();
      return entry;
    });
  }

  /** Forgets the endpoint's settings and engine on this instance: the next request reads and builds afresh. */
  async reload(id: string): Promise<void> {
    this.#missingUntil.delete(id);
    const entry = this.#entries.get(id);
    if (entry) await this.#drop(entry);
  }

  /** Unknown ids are remembered for one TTL, in a bounded map: random ids must not grow memory without limit. */
  #rememberMissing(id: string): void {
    const now = this.#now();
    if (this.#missingUntil.size >= MISSING_MAX) {
      for (const [known, until] of this.#missingUntil) if (until <= now) this.#missingUntil.delete(known);
      // Still full of live entries: forget the oldest (insertion order) rather than grow.
      while (this.#missingUntil.size >= MISSING_MAX) this.#missingUntil.delete(this.#missingUntil.keys().next().value!);
    }
    this.#missingUntil.set(id, now + this.#options.ttlMs);
  }

  /** After a Crystallize on this instance: the same settings, the Crystals it just published. */
  async replace(id: string, crystals: CrystalLoad): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.etag = crystals.etag;
    const runtime = await this.#build(this.#envFor(entry), { ...this.#depsFor(entry), crystals });
    await this.#install(entry, runtime, entry.engineFingerprint());
  }

  async #refresh(id: string): Promise<Entry | undefined> {
    const own = await this.#readParameters(`${ENDPOINTS_SSM_PREFIX}${id}/`);
    if (Object.keys(own).length === 0) {
      this.#rememberMissing(id);
      const deleted = this.#entries.get(id);
      if (deleted) await this.#drop(deleted);
      return undefined;
    }
    this.#missingUntil.delete(id);
    const [shared, etag] = await Promise.all([this.#sharedValues(), this.#options.crystals.version(id)]);
    let entry = this.#entries.get(id);
    if (!entry) {
      const created: Entry = new Entry(id, () => this.#runtimeFor(created), () => this.#feedFor(created));
      entry = created;
      this.#entries.set(id, entry);
      await this.#evictBeyondCap();
    }
    this.#touch(entry);
    entry.update(own, shared, etag, this.#now());
    return entry;
  }

  /** Built once per entry: the table and the tenant id never change for an id. */
  #feedFor(entry: Entry): StoredRequests {
    if (entry.storedFeed) return entry.storedFeed;
    const env = this.#envFor(entry);
    const log = (line: LogLine) => this.#log({ endpointId: entry.id, ...line });
    const store = new DynamoSlimeStore({
      table: env.SLIME_HANDLERS_TABLE ?? '',
      tenantId: entry.id,
      ...(this.#options.storeClient ? { client: this.#options.storeClient } : {}),
    });
    // The same total as the engine's feed (endpoint-runtime.ts): the usage count across instances.
    // This meter only reads, so its snapshot is never taken.
    const meter = env.SLIME_USAGE_TABLE
      ? new UsageMeter(env.SLIME_USAGE_TABLE, entry.id, () => ({ gas: 0, liquid: 0, crystal: 0 }), this.#options.usageClient)
      : undefined;
    entry.storedFeed = new StoredRequests({ store, ...(meter ? { total: () => meter.total() } : {}), log });
    return entry.storedFeed;
  }

  #runtimeFor(entry: Entry): Promise<EndpointRuntime> {
    const fingerprint = entry.engineFingerprint();
    if (entry.engine?.fingerprint === fingerprint) return Promise.resolve(entry.engine.runtime);
    // Concurrent first requests share one build; a failed build is not kept, so the next request retries.
    entry.building ??= this.#startEngine(entry, fingerprint).finally(() => {
      entry.building = undefined;
    });
    return entry.building;
  }

  async #startEngine(entry: Entry, fingerprint: string): Promise<EndpointRuntime> {
    const startedAt = performance.now();
    let runtime: EndpointRuntime;
    try {
      runtime = await this.#build(this.#envFor(entry), this.#depsFor(entry));
    } catch (error) {
      this.#log({ endpointId: entry.id, bootFailed: startupErrorMessage(error) });
      throw error;
    }
    this.#log({ endpointId: entry.id, tenantBuildMs: Math.round(performance.now() - startedAt), rss: process.memoryUsage().rss });
    // Dropped while it started (reloaded, deleted, evicted): it answers the requests that waited
    // for it, and is not cached; its idle pool clients time out on their own.
    if (!entry.isDropped) await this.#install(entry, runtime, fingerprint);
    return runtime;
  }

  async #install(entry: Entry, runtime: EndpointRuntime, fingerprint: string): Promise<void> {
    const old = entry.engine?.runtime;
    entry.engine = { runtime, fingerprint };
    if (old) await this.#retire(entry.id, old);
  }

  #envFor(entry: Entry): Env {
    return { ...this.#options.baseEnv, ...entry.shared, ...entry.own, SLIME_TENANT_ID: entry.id };
  }

  #depsFor(entry: Entry): EndpointDeps {
    return {
      runner: this.#options.runner,
      crystalStore: this.#options.crystals,
      isPerInstance: true,
      onCrystallized: (crystals) => this.replace(entry.id, crystals),
      log: this.#log,
    };
  }

  async #evictBeyondCap(): Promise<void> {
    while (this.#entries.size > this.#options.maxEntries) {
      const [oldest] = this.#entries.values();
      if (!oldest) return;
      await this.#drop(oldest);
    }
  }

  async #drop(entry: Entry): Promise<void> {
    entry.isDropped = true;
    if (this.#entries.get(entry.id) === entry) this.#entries.delete(entry.id);
    const runtime = entry.engine?.runtime;
    entry.engine = undefined;
    if (runtime) await this.#retire(entry.id, runtime);
  }

  /** Flush, save live run counts, close: capped, so one slow review cannot stall another endpoint's request. */
  async #retire(id: string, runtime: EndpointRuntime): Promise<void> {
    const closing = runtime.close().catch((error: unknown) => this.#log({ endpointId: id, warning: `Could not close the engine cleanly: ${startupErrorMessage(error)}` }));
    await Promise.race([closing, sleep(this.#options.retireLimitMs ?? DEFAULT_RETIRE_LIMIT_MS, undefined, { ref: false })]);
    this.#log({ endpointId: id, retired: true, rss: process.memoryUsage().rss });
  }

  #touch(entry: Entry): void {
    this.#entries.delete(entry.id);
    this.#entries.set(entry.id, entry);
  }

  async #sharedValues(): Promise<Values> {
    const shared = this.#shared;
    if (shared && this.#now() - shared.readAt < this.#options.ttlMs) return shared.values;
    this.#sharedReading ??= this.#readParameters(this.#options.sharedPrefix)
      .then((values) => {
        this.#shared = { values, readAt: this.#now() };
        return values;
      })
      .finally(() => {
        this.#sharedReading = undefined;
      });
    return this.#sharedReading;
  }

  async #readParameters(path: string): Promise<Values> {
    const values: Values = {};
    let NextToken: string | undefined;
    do {
      const page = await this.#options.ssm.send(new GetParametersByPathCommand({ Path: path, WithDecryption: true, NextToken }));
      for (const { Name, Value } of page.Parameters ?? []) {
        if (Name && Value !== undefined) values[parameterName(Name)] = Value;
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return values;
  }
}
