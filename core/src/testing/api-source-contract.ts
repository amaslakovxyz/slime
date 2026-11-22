// The ApiSource contract. Every API adapter, built in or app-defined, must pass
// it (MS2). The adapter's own test supplies one operation and its arguments.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { matchesLeaf } from '../request/shape.js';
import type { ApiSource, OperationInfo } from '../sources/api/types.js';

export type ApiSourceFactory = () => ApiSource | Promise<ApiSource>;

export interface ApiSourceContractCase {
  operation: string;
  /** Arguments that filter, returning at least one row. */
  args: Readonly<Record<string, unknown>>;
  /** Every declared param set to null: "not given" (R5). */
  allNullArgs: Readonly<Record<string, unknown>>;
}

export interface ApiSourceContractOptions {
  name: string;
  makeSource: ApiSourceFactory;
  cases: ApiSourceContractCase[];
  skip?: boolean;
}

const TIMEOUT_MS = 5_000;
const options = (overrides: Partial<{ rowCap: number; signal: AbortSignal }> = {}) => ({ timeoutMs: TIMEOUT_MS, rowCap: 1_000, signal: new AbortController().signal, ...overrides });

export function describeApiSourceContract({ name, makeSource, cases, skip = false }: ApiSourceContractOptions): void {
  describe(`ApiSource contract: ${name}`, { skip }, () => {
    test('describe() is valid and the same on every call', async () => {
      const source = await makeSource();
      const first = await source.describe(options());
      assert.ok(first.service.trim(), 'service is described');
      assert.ok(first.operations.length > 0, 'at least one operation');
      assert.deepEqual(await source.describe(options()), first);
    });

    for (const testCase of cases) {
      test(`${testCase.operation}: rows match the declared columns`, async () => {
        const source = await makeSource();
        const operation = await operationOf(source, testCase.operation);
        const { rows } = await source.call(testCase.operation, testCase.args, options());
        assert.ok(rows.length > 0, 'the filtering args return at least one row');
        for (const row of rows) assertRowMatches(operation, row);
      });

      test(`${testCase.operation}: null params add no filter`, async () => {
        const source = await makeSource();
        const filtered = await source.call(testCase.operation, testCase.args, options());
        const unfiltered = await source.call(testCase.operation, testCase.allNullArgs, options());
        assert.ok(unfiltered.rows.length >= filtered.rows.length, `${unfiltered.rows.length} unfiltered rows, ${filtered.rows.length} filtered`);
      });

      test(`${testCase.operation}: rowCap cuts rows and sets truncated`, async () => {
        const source = await makeSource();
        const result = await source.call(testCase.operation, testCase.allNullArgs, options({ rowCap: 1 }));
        assert.equal(result.rows.length, 1);
        assert.equal(result.truncated, true, 'needs at least two unfiltered rows');
      });

      test(`${testCase.operation}: an aborted signal rejects`, async () => {
        const source = await makeSource();
        const controller = new AbortController();
        controller.abort(new Error('aborted by the contract'));
        await assert.rejects(source.call(testCase.operation, testCase.args, options({ signal: controller.signal })));
      });
    }

    test('unknown operations and params are refused, with no secret in the error', async () => {
      const source = await makeSource();
      const [firstCase] = cases;
      for (const call of [() => source.call('no.such.operation', {}, options()), () => source.call(firstCase?.operation ?? '', { noSuchParam: 1 }, options())]) {
        await assert.rejects(call(), (error: Error) => {
          for (const secret of source.secrets) if (secret) assert.ok(!error.message.includes(secret), 'the error message contains a secret');
          return true;
        });
      }
    });
  });
}

async function operationOf(source: ApiSource, name: string): Promise<OperationInfo> {
  const operation = (await source.describe(options())).operations.find((candidate) => candidate.name === name);
  assert.ok(operation, `describe() lists ${name}`);
  return operation;
}

function assertRowMatches(operation: OperationInfo, row: Record<string, unknown>): void {
  assert.deepEqual(Object.keys(row).sort(), operation.columns.map((column) => column.name).sort(), 'a row has exactly the declared columns');
  for (const column of operation.columns) {
    const type = column.nullable ? `${column.type}|null` : column.type;
    assert.ok(matchesLeaf(type, row[column.name]), `${operation.name}.${column.name}: ${JSON.stringify(row[column.name])} is not ${type}`);
  }
}
