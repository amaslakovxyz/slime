// Where Liquid handlers live between restarts. Gas stays in process memory only:
// it is unreviewed or unproven, so a restart is allowed to forget it.
import pg from 'pg';
import { canonicalJSON, sha256 } from './fingerprint.js';
import type { Artifact } from './prompts.js';
import type { Shape } from './shape.js';

/** One successful run, recorded so the handler can be re-checked later (Crystal's equivalence test). */
export interface Fixture {
  input: Record<string, unknown>;
  output: unknown;
  at: string;
}

export interface StoredReview {
  status: string;
  reviews: number;
  problems: string[];
}

export interface StoredHandler {
  artifactKey: string;
  fingerprint: string;
  intent: string;
  inputSig: Record<string, string>;
  output: Shape;
  artifact: Artifact;
  codeHash: string;
  schemaHash: string;
  promptHash: string;
  model: string;
  revision: number;
  review: StoredReview;
  history: { artifact: Artifact; rejectedFor: string[] }[];
  fixtures: Fixture[];
  runs: number;
  createdAt: string;
  promotedAt: string;
  lastUsedAt: string;
}

/** Only handlers generated against the same schema, prompt and model are reusable. */
export interface StoreScope {
  schemaHash: string;
  promptHash: string;
  model: string;
}

export interface HandlerStore {
  readonly kind: string;
  init(): Promise<void>;
  loadLiquid(scope: StoreScope): Promise<StoredHandler[]>;
  saveLiquid(handler: StoredHandler): Promise<void>;
  updateRuns(artifactKey: string, fixtures: Fixture[], runs: number, lastUsedAt: string): Promise<void>;
  close(): Promise<void>;
}

/** Hash of exactly the code that runs. Checked on load, so edited rows are refused. */
export function codeHash(artifact: Artifact): string {
  return sha256(canonicalJSON({ sql: artifact.sql, params: artifact.params, shapeJs: artifact.shapeJs }));
}

export class MemoryHandlerStore implements HandlerStore {
  readonly kind = 'memory';
  readonly rows = new Map<string, StoredHandler>();

  async init() {}

  async loadLiquid(scope: StoreScope) {
    return [...this.rows.values()]
      .filter((r) => r.schemaHash === scope.schemaHash && r.promptHash === scope.promptHash && r.model === scope.model)
      .map((r) => structuredClone(r));
  }

  async saveLiquid(handler: StoredHandler) {
    this.rows.set(handler.artifactKey, structuredClone(handler));
  }

  async updateRuns(artifactKey: string, fixtures: Fixture[], runs: number, lastUsedAt: string) {
    const row = this.rows.get(artifactKey);
    if (row) Object.assign(row, { fixtures: structuredClone(fixtures), runs, lastUsedAt });
  }

  async close() {}
}

export class PostgresHandlerStore implements HandlerStore {
  readonly kind = 'postgres';
  private pool: pg.Pool;
  private readonly table: string;

  /** `table` lets tests use their own table so they never touch a dev server's handlers. */
  constructor(connectionString: string, table = 'handlers') {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`invalid table name "${table}"`);
    this.pool = new pg.Pool({ connectionString, max: 2 });
    this.table = `slime_meta.${table}`;
  }

  // Slime owns its table and creates it on first start; no separate migration step.
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        artifact_key  text PRIMARY KEY,
        fingerprint   text        NOT NULL,
        tier          text        NOT NULL CHECK (tier IN ('liquid', 'crystal')),
        intent        text        NOT NULL,
        input_sig     jsonb       NOT NULL,
        output_shape  jsonb       NOT NULL,
        artifact      jsonb       NOT NULL,
        code_hash     text        NOT NULL,
        schema_hash   text        NOT NULL,
        prompt_hash   text        NOT NULL,
        model         text        NOT NULL,
        revision      integer     NOT NULL,
        review        jsonb       NOT NULL,
        history       jsonb       NOT NULL,
        fixtures      jsonb       NOT NULL,
        runs          bigint      NOT NULL,
        created_at    timestamptz NOT NULL,
        promoted_at   timestamptz NOT NULL,
        last_used_at  timestamptz NOT NULL
      )`);
  }

  async loadLiquid(scope: StoreScope): Promise<StoredHandler[]> {
    const res = await this.pool.query(
      `SELECT * FROM ${this.table}
       WHERE tier = 'liquid' AND schema_hash = $1 AND prompt_hash = $2 AND model = $3`,
      [scope.schemaHash, scope.promptHash, scope.model],
    );
    return res.rows.map((r) => ({
      artifactKey: r.artifact_key,
      fingerprint: r.fingerprint,
      intent: r.intent,
      inputSig: r.input_sig,
      output: r.output_shape,
      artifact: r.artifact,
      codeHash: r.code_hash,
      schemaHash: r.schema_hash,
      promptHash: r.prompt_hash,
      model: r.model,
      revision: r.revision,
      review: r.review,
      history: r.history,
      fixtures: r.fixtures,
      runs: Number(r.runs),
      createdAt: new Date(r.created_at).toISOString(),
      promotedAt: new Date(r.promoted_at).toISOString(),
      lastUsedAt: new Date(r.last_used_at).toISOString(),
    }));
  }

  async saveLiquid(h: StoredHandler) {
    const json = (v: unknown) => JSON.stringify(v);
    await this.pool.query(
      `INSERT INTO ${this.table} (artifact_key, fingerprint, tier, intent, input_sig, output_shape, artifact,
         code_hash, schema_hash, prompt_hash, model, revision, review, history, fixtures, runs,
         created_at, promoted_at, last_used_at)
       VALUES ($1, $2, 'liquid', $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb,
         $14::jsonb, $15, $16, $17, $18)
       ON CONFLICT (artifact_key) DO UPDATE SET
         artifact = EXCLUDED.artifact, code_hash = EXCLUDED.code_hash, revision = EXCLUDED.revision,
         review = EXCLUDED.review, history = EXCLUDED.history, fixtures = EXCLUDED.fixtures,
         runs = EXCLUDED.runs, promoted_at = EXCLUDED.promoted_at, last_used_at = EXCLUDED.last_used_at`,
      [
        h.artifactKey, h.fingerprint, h.intent, json(h.inputSig), json(h.output), json(h.artifact),
        h.codeHash, h.schemaHash, h.promptHash, h.model, h.revision, json(h.review), json(h.history),
        json(h.fixtures), h.runs, h.createdAt, h.promotedAt, h.lastUsedAt,
      ],
    );
  }

  async updateRuns(artifactKey: string, fixtures: Fixture[], runs: number, lastUsedAt: string) {
    await this.pool.query(
      `UPDATE ${this.table} SET fixtures = $2::jsonb, runs = $3, last_used_at = $4 WHERE artifact_key = $1`,
      [artifactKey, JSON.stringify(fixtures), runs, lastUsedAt],
    );
  }

  close() {
    return this.pool.end();
  }
}
