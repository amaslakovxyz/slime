// One endpoint's runtime: config, engine, usage meter, live feed, Lifecycle data and
// Crystallize, wired into the HTTP app. Both entries compose an endpoint here: local.ts
// once per process with process.env, the Lambda tenant cache once per cached endpoint
// with that endpoint's own env object. It reads only the env it is given, never
// process.env, so one endpoint's settings cannot reach another's.
import { changedProvenance, createSlime, type Generator, type HandlerProvenance, type SandboxRunner, type Slime } from '@slime-cloud/core';
import { Crystallizer } from '@slime-cloud/crystal';
import type { Hono } from 'hono';
import { createApp, type CrystallizeOutcome, type SavedHandler } from './app.js';
import { parseCrystalTokens } from './auth.js';
import { missingProviderKey, slimeConfigFromEnv, type Env } from './config.js';
import { CrystallizeConflictError, crystalsFromFolder, type CrystalLoad, type CrystalStore } from './crystal-store.js';
import { RecentRequests, StoredRequests } from './events.js';
import { DEFAULT_RUNS_SYNC_MS, LiveRunsSync, syncLiveRuns } from './live-runs.js';
import type { DocClient } from './store-dynamodb.js';
import { UsageMeter } from './usage.js';

const HANDLERS_NS = 'handlers';

export type LogLine = Record<string, unknown>;

export interface EndpointDeps {
  /** The process's shared sandbox; omit for the engine's own (local: one endpoint per process). */
  runner?: SandboxRunner;
  /** Where Crystals load from and Crystallize publishes to. Absent: no Crystals and no `POST /v0/crystallize`. */
  crystalStore?: CrystalStore;
  /** Crystals already in hand (just published by Crystallize): the store is not read again. */
  crystals?: CrystalLoad;
  /** Called after Crystallize published new Crystals; the Lambda tenant cache swaps this endpoint's engine. */
  onCrystallized?: (crystals: CrystalLoad) => Promise<void>;
  /** The feed and Gas rows are this process's only, one of several (Lambda): the Lifecycle payload says so. */
  isPerInstance?: boolean;
  /** Tests pass a fake DynamoDB for the handler store. */
  storeClient?: DocClient;
  /** Tests pass a fake generator (cannedGenerator) instead of the endpoint's provider. */
  generator?: Generator;
  /** One JSON line per call; defaults to stdout. Every line carries `endpointId`. */
  log?: (line: LogLine) => void;
}

export interface EndpointRuntime {
  app: Hono;
  slime: Slime;
  /** Store writes, reviews and usage: awaited before a response goes out (Lambda freezes after it). */
  flush(): Promise<void>;
  /** Flush, save live run counts, then close the engine (and with it the connector). */
  close(): Promise<void>;
  apiKey: string | undefined;
  crystalTokens: Readonly<Record<string, string>>;
  crystalCount: number;
}


type RecordLike = {
  key: string;
  intent: string;
  tier: 'gas' | 'liquid';
  runs: number;
  review: string;
  fixtures: unknown[];
  createdAt: string;
  provenance: HandlerProvenance;
};

/** `current` is the provenance new handlers are made with: a saved record made with another one is stale. */
export function toSavedHandler(value: unknown, current?: HandlerProvenance): SavedHandler {
  const r = value as RecordLike;
  const isStale = current !== undefined && changedProvenance(r.provenance, current).length > 0;
  return {
    key: r.key,
    intent: r.intent,
    tier: r.tier,
    runs: r.runs,
    review: r.review,
    fixtures: r.fixtures?.length ?? 0,
    createdAt: r.createdAt,
    ...(isStale ? { stale: true } : {}),
  };
}

export async function endpointRuntime(env: Env, deps: EndpointDeps = {}): Promise<EndpointRuntime> {
  const endpointId = env.SLIME_TENANT_ID ?? '';
  const write = deps.log ?? ((line: LogLine) => console.log(JSON.stringify(line)));
  const log = (line: LogLine) => write({ endpointId, ...line });
  // Startup and engine warnings (a missing provider key, a dropped Crystal, Crystals made against
  // another schema) go to the log and the Lifecycle tab.
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    log({ warning: message });
  };
  const keyWarning = deps.generator ? undefined : missingProviderKey(env);
  if (keyWarning) warn(keyWarning);

  const { crystalStore } = deps;
  const crystals = deps.crystals ?? (crystalStore && env.SLIME_CRYSTAL !== 'off' ? await crystalStore.load(endpointId) : undefined);
  for (const message of crystals?.warnings ?? []) warn(message);

  // The meter needs slime for its snapshot, so it is assigned after createSlime; startup
  // events emitted before that are not generations.
  let meter: UsageMeter | undefined;
  const config = await slimeConfigFromEnv(env, {
    onEvent: (event) => {
      if (event.type === 'generated') meter?.recordTokens(event.tokens);
      if (event.type === 'warning') warn(event.message);
    },
    ...(crystals ? { crystal: crystals.registry } : {}),
    ...(deps.storeClient ? { storeClient: deps.storeClient } : {}),
    ...(deps.generator ? { generator: deps.generator } : {}),
  });
  let slime: Slime;
  try {
    slime = await createSlime(config, deps.runner ? { runner: deps.runner } : {});
  } catch (error) {
    // A tenant whose database refuses to start is retried on its next request: don't leak a pool each time.
    await config.connector.close();
    throw error;
  }

  const crystalCount = Object.keys(config.crystal || {}).length;
  // Same counters locally and in the cloud (USAGE#<endpoint> items); absent table means no metering.
  if (env.SLIME_USAGE_TABLE) {
    meter = new UsageMeter(env.SLIME_USAGE_TABLE, endpointId, () => ({ ...slime.stats().handlers, crystal: crystalCount }));
  }
  const store = config.store;
  // Keeps Liquid run counts in the store current, so Crystallize can see them (see live-runs.ts).
  const runs = store ? new LiveRunsSync(store, () => slime.handlers(), Number(env.SLIME_RUNS_SYNC_MS || DEFAULT_RUNS_SYNC_MS)) : undefined;
  const crystalRuns = config.tiers.crystalReadyRuns;
  // The feed lives in the store, so every warm instance serves the same one; its total is the
  // endpoint's usage count, which every instance adds to atomically.
  const events = store ? new StoredRequests({ store, ...(meter ? { total: () => meter!.total() } : {}), log }) : new RecentRequests();

  const crystallizeKeys = async (keys?: string[]): Promise<CrystallizeOutcome[]> => {
    if (!store || !crystalStore) return [];
    // Liquid run counts and fixtures must be in the store before the job reads them. Every handler's,
    // not only the picked ones: the restart or swap that follows drops the live counts.
    await slime.flush();
    await syncLiveRuns(store, slime.handlers());
    const work = await crystalStore.prepareWork(endpointId);
    try {
      // The instance's connector, sandbox, provenance and live counts; minRuns is tiers.crystalReadyRuns (CRYSTAL_MIN_RUNS).
      const reports = await new Crystallizer(slime, { dir: work.dir }).run(keys ? { keys } : {});
      if (!reports.some(({ outcome }) => outcome === 'crystallized')) return reports;
      let etag: string | undefined;
      try {
        etag = await crystalStore.publish(endpointId, work);
      } catch (error) {
        if (!(error instanceof CrystallizeConflictError)) throw error;
        return reports.map((report) =>
          report.outcome === 'crystallized' ? { ...report, outcome: 'failed', reasons: [...report.reasons, error.message] } : report,
        );
      }
      // Published is done: a swap that fails (the database blinked) only delays this instance,
      // which loads the new Crystals on a later request, as the other instances do.
      if (deps.onCrystallized) {
        await deps.onCrystallized({ ...(await crystalsFromFolder(work.dir)), etag }).catch((error: unknown) =>
          log({ warning: `Crystals published, but this instance could not load them yet: ${startupErrorMessage(error)}` }),
        );
      }
      return reports;
    } finally {
      await crystalStore.discardWork(work);
    }
  };

  const app = createApp({
    slime,
    connector: config.connector,
    crystal: config.crystal,
    events,
    onQuery: (meta) => meter?.record(meta),
    log,
    thresholds: { liquidRuns: config.tiers.gasToLiquidRuns, crystalRuns },
    warnings: () => [...warnings],
    ...(deps.isPerInstance ? { isPerInstance: true } : {}),
    // Drifted records are generated again on their next request, so they show as stale.
    savedHandlers: async () => {
      const current = slime.provenance();
      return store ? (await store.list(HANDLERS_NS)).map(({ value }) => toSavedHandler(value, current)) : [];
    },
    ...(store && crystalStore ? { crystallize: crystallizeKeys } : {}),
  });

  const flush = async () => {
    await Promise.all([slime.flush(), meter?.flush(), events instanceof StoredRequests ? events.flush() : undefined]);
    await runs?.maybeSync();
  };

  return {
    app,
    slime,
    flush,
    close: async () => {
      await Promise.all([slime.flush(), meter?.flush(), events instanceof StoredRequests ? events.flush() : undefined]);
      // The core saves a handler's runs only when it turns Liquid: save the live counts, or a
      // restart or eviction sets Liquid progress back.
      if (store) await syncLiveRuns(store, slime.handlers());
      await slime.close();
    },
    apiKey: env.SLIME_API_KEY,
    crystalTokens: parseCrystalTokens(env.CRYSTAL_TOKENS),
    crystalCount,
  };
}

/** One line for a failure reason: the local runner shows it, and the Lambda logs it with the endpoint id. */
export function startupErrorMessage(err: unknown): string {
  // pg reports a refused connection as an AggregateError with an empty message, one error per address.
  if (err instanceof AggregateError && !err.message && err.errors.length > 0) return startupErrorMessage(err.errors[0]);
  const text = err instanceof Error ? err.message || (err as { code?: string }).code || err.name : String(err);
  return text.replace(/\s+/g, ' ').trim();
}
