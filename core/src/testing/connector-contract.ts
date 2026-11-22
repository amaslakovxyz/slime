// The Connector contract. Every connector, built in or custom, must pass it.
// It never assumes a dialect: the connector's own test supplies the SQL.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Connector, QueryLimits } from '../sources/sql/types.js';
import { SlimeError, type ErrorCode } from '../shared/errors.js';

export type ConnectorFactory = () => Connector | Promise<Connector>;

/** Binds the params and returns exactly `rows`, in order. */
export interface ParameterizedQuery {
  sql: string;
  params: unknown[];
  rows: Record<string, unknown>[];
}

/** SQL in the connector's dialect, with $1, $2, ... placeholders as the engine sends them. */
export interface ConnectorContractQueries {
  parameterized: ParameterizedQuery;
  /** One row whose every column is a count or a sum: all must come back as numbers. */
  aggregates: string;
  /** Returns at least 10 rows. */
  manyRows: string;
  /** A write the read-only user must be refused. */
  write: string;
  /** Runs for longer than 3 seconds. */
  slow: string;
}

/** A table the reader can read, and optionally a column of it hidden from the reader. */
export interface DescribeExpectation {
  table: string;
  hiddenColumn?: string;
}

export interface ConnectorContractOptions {
  /** Read-only credentials on a database the queries can run against. */
  createReader: ConnectorFactory;
  /** Credentials that can write; omit to skip the safety-check refusal case. */
  createWriter?: ConnectorFactory;
  queries: ConnectorContractQueries;
  describes: DescribeExpectation;
  /** Skips the whole suite, for example when the database is not running locally. */
  skip?: boolean;
}

const LIMITS: QueryLimits = { timeoutMs: 2_000, rowCap: 1_000 };
const SMALL_ROW_CAP = 5;
const SHORT_TIMEOUT_MS = 300;
// The timeout must stop the query well before `slow` would finish by itself.
const TIMEOUT_DEADLINE_MS = 2_500;
const WRITE_REFUSAL_CODES: readonly ErrorCode[] = ['WRITE_REFUSED', 'ACCESS_DENIED', 'QUERY_ERROR'];

async function errorCodeOf(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
    return 'OK';
  } catch (error) {
    return error instanceof SlimeError ? error.code : `not a SlimeError: ${String(error)}`;
  }
}

export function describeConnectorContract(connectorName: string, options: ConnectorContractOptions): void {
  const { queries, describes } = options;

  describe(`${connectorName} connector: Connector contract`, { skip: options.skip ?? false }, () => {
    let reader: Connector;
    before(async () => {
      reader = await options.createReader();
    });
    after(() => reader?.close());

    test('the safety check passes for read-only credentials', async () => {
      const report = await reader.safetyCheck();
      assert.deepEqual([report.ok, report.problems], [true, []]);
    });

    test('describe names the dialect and lists only what the reader can read', async () => {
      const { dialect, tables } = await reader.describe();
      assert.ok(dialect.length > 0, 'dialect is shown to the model, so it must not be empty');
      const table = tables.find(({ name }) => name === describes.table);
      assert.ok(table, `describe() lists ${describes.table}`);
      if (describes.hiddenColumn) assert.ok(!table.columns.some(({ name }) => name === describes.hiddenColumn), `${describes.hiddenColumn} is hidden`);
    });

    test('run binds $n parameters', async () => {
      const { sql, params, rows } = queries.parameterized;
      assert.deepEqual((await reader.run(sql, params, LIMITS)).rows, rows);
    });

    test('run returns counts and sums as numbers', async () => {
      const [row] = (await reader.run(queries.aggregates, [], LIMITS)).rows;
      assert.ok(row, 'aggregates returns a row');
      for (const [column, value] of Object.entries(row)) assert.equal(typeof value, 'number', column);
    });

    test('run caps rows at rowCap and reports truncation', async () => {
      const capped = await reader.run(queries.manyRows, [], { ...LIMITS, rowCap: SMALL_ROW_CAP });
      assert.deepEqual([capped.rows.length, capped.truncated], [SMALL_ROW_CAP, true]);
      assert.equal((await reader.run(queries.manyRows, [], LIMITS)).truncated, false);
    });

    test('check returns a plan without failing', async () => {
      const { cost } = await reader.check(queries.manyRows, [], LIMITS);
      assert.ok(cost === null || Number.isFinite(cost), `cost ${cost}`);
    });

    test('writes are refused with a SlimeError, alone or after a SELECT', async () => {
      for (const sql of [queries.write, `${queries.aggregates}; ${queries.write}`]) {
        const code = await errorCodeOf(reader.run(sql, [], LIMITS));
        assert.ok(WRITE_REFUSAL_CODES.includes(code as ErrorCode), `${sql}: ${code}`);
      }
    });

    test('a query over the timeout fails with EXECUTION_TIMEOUT', async () => {
      const startedAt = performance.now();
      assert.equal(await errorCodeOf(reader.run(queries.slow, [], { ...LIMITS, timeoutMs: SHORT_TIMEOUT_MS })), 'EXECUTION_TIMEOUT');
      assert.ok(performance.now() - startedAt < TIMEOUT_DEADLINE_MS, 'stopped near the timeout');
    });

    test('the safety check refuses credentials that can write', { skip: !options.createWriter }, async () => {
      const writer = await options.createWriter!();
      try {
        const report = await writer.safetyCheck();
        assert.equal(report.ok, false);
        assert.ok(report.problems.length > 0, 'it says what the user can write');
      } finally {
        await writer.close();
      }
    });
  });
}
