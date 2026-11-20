import pg from 'pg';
import { config } from '../src/config.js';
import { PostgresConnector } from '../src/connectors/postgres.js';
import { Engine } from '../src/engine.js';
import type { GenerationRequest, GenerationResult, Generator } from '../src/generator.js';
import type { Artifact } from '../src/prompts.js';
import type { ReviewResult, Reviewer } from '../src/review.js';
import { MemoryHandlerStore, type HandlerStore } from '../src/store.js';

export const DB_URL = process.env.DATABASE_URL!;
export const META_URL = process.env.META_DATABASE_URL!;

/**
 * Database tests need the docker Postgres (`npm run db:up`). Locally they are
 * skipped when it isn't running; CI sets REQUIRE_DB=1 so a missing DB fails.
 */
export async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch (err) {
    if (process.env.REQUIRE_DB === '1') throw new Error(`REQUIRE_DB=1 but Postgres is unreachable: ${(err as Error).message}`);
    console.warn(`# skipping database tests: ${(err as Error).message} (start it with npm run db:up)`);
    return false;
  }
}

export function artifact(sql: string, params: string[] = [], shapeJs: string | null = null): Artifact {
  return { unsatisfiable: null, sql, params, shapeJs, assumptions: [] };
}

/** Returns scripted artifacts in order (the last one repeats) and counts calls. */
export class StubGenerator implements Generator {
  calls = 0;
  requests: GenerationRequest[] = [];
  constructor(private readonly script: (Artifact | (() => Artifact | Promise<Artifact>))[], private readonly delayMs = 0) {}

  async generate(req: GenerationRequest): Promise<GenerationResult> {
    this.requests.push(req);
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const a = typeof step === 'function' ? await step() : step;
    return { artifact: structuredClone(a), ms: this.delayMs, waitMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  }
}

/** Returns scripted verdicts in order (the last one repeats). */
export class StubReviewer implements Reviewer {
  readonly model = 'stub';
  calls = 0;
  constructor(private readonly verdicts: ('approve' | 'reject' | 'error')[]) {}

  async review(): Promise<ReviewResult> {
    const v = this.verdicts[Math.min(this.calls, this.verdicts.length - 1)];
    this.calls++;
    if (v === 'error') throw new Error('reviewer unavailable');
    return { verdict: v, problems: v === 'reject' ? ['stub reviewer rejected this handler'] : [], ms: 0, waitMs: 0, inputTokens: 0, outputTokens: 0 };
  }
}

const opened: { engine: Engine; connector: PostgresConnector }[] = [];

export async function makeEngine(opts: {
  generator?: Generator;
  reviewer?: Reviewer | null;
  store?: HandlerStore;
} = {}): Promise<Engine> {
  const connector = new PostgresConnector(DB_URL);
  const engine = await Engine.create(connector, {
    generator: opts.generator ?? new StubGenerator([artifact('SELECT 1 AS "one"')]),
    reviewer: opts.reviewer === undefined ? new StubReviewer(['approve']) : opts.reviewer,
    store: opts.store ?? new MemoryHandlerStore(),
  });
  opened.push({ engine, connector });
  return engine;
}

export async function closeEngines() {
  for (const { engine, connector } of opened.splice(0)) {
    await engine.close();
    await connector.close();
  }
}

/** Runs `fn` with some config values changed, then restores them. */
export async function withConfig<T>(overrides: Partial<typeof config>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(overrides).map((k) => [k, config[k as keyof typeof config]]));
  Object.assign(config, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(config, saved);
  }
}

export const TOP_ACCOUNTS = {
  intent: 'top N accounts by total paid invoice amount in cents, highest first',
  output: [{ name: 'string', totalPaidCents: 'integer' }],
  artifact: artifact(
    `SELECT a.name AS "name", sum(i.amount_cents)::int AS "totalPaidCents"
     FROM accounts a JOIN invoices i ON i.account_id = a.id AND i.status = 'paid'
     GROUP BY a.id, a.name ORDER BY 2 DESC LIMIT $1::int`,
    ['limit'],
  ),
};
