import pg from 'pg';
import type { Connector, QueryLimits, QueryPlan, RunResult, SafetyReport, SchemaInfo } from '../types.js';
import { toSlimeError } from './database-errors.js';
import { describeSchema } from './describe.js';
import { checkSafety } from './safety.js';

export interface PostgresConnectorOptions {
  /** A read-only database user; createSlime() refuses one that can write. */
  url: string;
  schema?: string;
  maxConnections?: number;
}

interface ExplainRow {
  'QUERY PLAN': { Plan: { 'Total Cost': number } }[];
}

// pg's typings lack query_timeout, which pg reads per query (lib/client.js).
interface TimedQuery extends pg.QueryConfig {
  query_timeout: number;
}

const DEFAULT_SCHEMA = 'public';
const DEFAULT_MAX_CONNECTIONS = 10;
// Generated SQL could lift the server-side timeout with set_config(), so the client gives up too.
const CLIENT_TIMEOUT_MARGIN_MS = 1_000;
const INT8_OID = 20;
const NUMERIC_OID = 1700;
const TRAILING_SEMICOLONS = /;\s*$/;

// pg returns int8 (COUNT, SUM) and numeric as strings, which would fail "number"
// leaves. Set per pool, so the app's own pg settings stay untouched.
const NUMBER_TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) =>
    oid === INT8_OID || oid === NUMERIC_OID ? Number : pg.types.getTypeParser(oid, format as 'text')) as pg.CustomTypesConfig['getTypeParser'],
};

export function postgresConnector(options: PostgresConnectorOptions): Connector {
  return new PostgresConnector(options);
}

class PostgresConnector implements Connector {
  readonly name = 'postgres';
  readonly #pool: pg.Pool;
  readonly #schema: string;

  constructor({ url, schema = DEFAULT_SCHEMA, maxConnections = DEFAULT_MAX_CONNECTIONS }: PostgresConnectorOptions) {
    this.#pool = new pg.Pool({ connectionString: url, max: maxConnections, types: NUMBER_TYPES });
    this.#schema = schema;
  }

  describe(): Promise<SchemaInfo> {
    return describeSchema(this.#pool, this.#schema);
  }

  async check(sql: string, params: unknown[], limits: QueryLimits): Promise<QueryPlan> {
    const startedAt = performance.now();
    const result = await this.#readOnly(limits, (client) => client.query<ExplainRow>(timed(`EXPLAIN (FORMAT JSON) ${wrap(sql, limits)}`, params, limits)));
    const cost = result.rows[0]?.['QUERY PLAN'][0]?.Plan['Total Cost'] ?? 0;
    return { cost, ms: performance.now() - startedAt };
  }

  async run(sql: string, params: unknown[], limits: QueryLimits): Promise<RunResult> {
    const startedAt = performance.now();
    const result = await this.#readOnly(limits, (client) => client.query(timed(wrap(sql, limits), params, limits)));
    const truncated = result.rows.length > limits.rowCap;
    return { rows: truncated ? result.rows.slice(0, limits.rowCap) : result.rows, truncated, ms: performance.now() - startedAt };
  }

  safetyCheck(): Promise<SafetyReport> {
    return checkSafety(this.#pool);
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  // Defence in depth: the read-only user is the boundary; this also blocks writes and caps time per query.
  async #readOnly<T>(limits: QueryLimits, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let isBroken = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(limits.timeoutMs)}`);
      return await work(client);
    } catch (error) {
      throw toSlimeError(error, limits.timeoutMs);
    } finally {
      isBroken = await rollback(client);
      // A connection whose state can't be trusted is destroyed, not reused.
      client.release(isBroken);
    }
  }
}

// As a subquery, anything but one SELECT or WITH (e.g. "...; DROP TABLE x") is a
// syntax error, and the outer LIMIT caps the rows. An inner ORDER BY is kept.
function wrap(sql: string, { rowCap }: QueryLimits): string {
  return `SELECT * FROM (\n${sql.trim().replace(TRAILING_SEMICOLONS, '')}\n) AS slime_query LIMIT ${rowCap + 1}`;
}

function timed(text: string, values: unknown[], { timeoutMs }: QueryLimits): TimedQuery {
  return { text, values, query_timeout: timeoutMs + CLIENT_TIMEOUT_MARGIN_MS };
}

/** Returns true when the rollback failed and the connection must not be reused. */
async function rollback(client: pg.PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return false;
  } catch {
    return true;
  }
}
