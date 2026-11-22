// An in-memory ApiSource for core's and apps' tests: no network.
import type { ColumnInfo } from '../sources/types.js';
import type { ApiSchema, ApiSource, CallOptions, ParamInfo } from '../sources/api/types.js';

export type FakeRow = Record<string, unknown>;

export interface FakeFailure {
  status: number;
  message: string;
}

export interface FakeOperation {
  description?: string;
  params?: ParamInfo[];
  columns: ColumnInfo[];
  rows: FakeRow[] | ((args: Readonly<Record<string, unknown>>) => FakeRow[]);
  failWith?: FakeFailure;
  /** The call waits for it: lets a test order events without timers. */
  gate?: Promise<void>;
}

export interface FakeApiSourceOptions {
  name?: string;
  service?: string;
  operations: Record<string, FakeOperation>;
  secrets?: string[];
  safetyFailWith?: FakeFailure;
  describeFailWith?: FakeFailure;
}

export interface FakeCall {
  operation: string;
  args: Readonly<Record<string, unknown>>;
}

export interface FakeApiSource extends ApiSource {
  readonly calls: readonly FakeCall[];
  readonly isClosed: boolean;
}

export const FAKE_SECRET = 'fake-secret-token';
const BAD_REQUEST = 400;

/** Scripted failures (failWith) carry a secret in their message, so redaction tests have something to remove. */
export function fakeApiSource({ name = 'fake-api', service = 'Fake API', operations, secrets = [FAKE_SECRET], safetyFailWith, describeFailWith }: FakeApiSourceOptions): FakeApiSource {
  const calls: FakeCall[] = [];
  let isClosed = false;
  const fail = ({ status, message }: FakeFailure): never => {
    throw Object.assign(new Error(`${message} (token ${secrets[0] ?? ''})`), { status });
  };
  return {
    kind: 'api',
    name,
    secrets,
    get calls() {
      return calls;
    },
    get isClosed() {
      return isClosed;
    },
    describe: async (): Promise<ApiSchema> => {
      if (describeFailWith) fail(describeFailWith);
      return { service, operations: Object.entries(operations).map(([operationName, operation]) => operationInfo(operationName, operation)) };
    },
    call: async (operationName, args, options) => {
      calls.push({ operation: operationName, args });
      const operation = operations[operationName];
      if (!operation) throw Object.assign(new Error(`unknown operation ${operationName}`), { status: BAD_REQUEST, isRetryable: false });
      const unknownArgs = Object.keys(args).filter((arg) => !(operation.params ?? []).some((param) => param.name === arg));
      if (unknownArgs.length > 0) throw Object.assign(new Error(`${operationName} has no param ${unknownArgs.join(', ')}`), { status: BAD_REQUEST, isRetryable: false });
      if (operation.gate) await waitUnlessAborted(operation.gate, options.signal);
      if (options.signal.aborted) throw options.signal.reason;
      if (operation.failWith) fail(operation.failWith);
      return cutRows(typeof operation.rows === 'function' ? operation.rows(args) : operation.rows, options);
    },
    safetyCheck: async () => {
      if (safetyFailWith) fail(safetyFailWith);
      return { ok: true, user: `${name}-bot`, problems: [] };
    },
    close: async () => {
      isClosed = true;
    },
  };
}

function operationInfo(name: string, { description, params = [], columns }: FakeOperation) {
  return { name, ...(description ? { description } : {}), params, columns };
}

function cutRows(rows: FakeRow[], { rowCap }: CallOptions) {
  const copy = structuredClone(rows);
  return { rows: copy.slice(0, rowCap), truncated: copy.length > rowCap, ms: 0 };
}

function waitUnlessAborted(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    gate.then(resolve, reject);
  });
}
