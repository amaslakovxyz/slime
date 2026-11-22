// Turns a declaration into an ApiSource: any REST API in a few dozen lines of
// app code, reached only through the constrained client (MS2, MS10).
import { SlimeConfigError } from '../../shared/errors.js';
import { SourceError } from './source-error.js';
import type { ApiSchema, ApiSource, CallOptions } from './types.js';
import { declarationProblems, operationInfo, type ApiRunContext, type ApiSourceDeclaration } from './declaration.js';
import { createHttpClient } from './http/http-client.js';

const BAD_REQUEST = 400;

export function defineApiSource(declaration: ApiSourceDeclaration): ApiSource {
  const problems = declarationProblems(declaration);
  if (problems.length > 0) throw new SlimeConfigError(problems.map((problem) => `${declaration.name ?? 'defineApiSource'}: ${problem}`));
  const name = declaration.name ?? new URL(declaration.baseUrl).host;
  const secrets = Object.freeze([...(declaration.secrets ?? []), ...Object.values(declaration.headers ?? {})]);
  const schema: ApiSchema = { service: declaration.service, operations: Object.entries(declaration.operations).map(([operationName, operation]) => operationInfo(operationName, operation)) };
  const context = (signal: AbortSignal): ApiRunContext => ({
    signal,
    http: createHttpClient({ baseUrl: declaration.baseUrl, secrets, signal, ...(declaration.headers ? { headers: declaration.headers } : {}), ...(declaration.fetchImpl ? { fetchImpl: declaration.fetchImpl } : {}) }),
  });

  return {
    kind: 'api',
    name,
    secrets,
    describe: async () => structuredClone(schema),
    async call(operationName: string, args: Readonly<Record<string, unknown>>, { rowCap, signal }: CallOptions) {
      const operation = declaration.operations[operationName];
      if (!operation) throw new SourceError(`${name} has no operation "${operationName}".`, { status: BAD_REQUEST, isRetryable: false });
      const unknownArgs = Object.keys(args).filter((arg) => !(arg in (operation.params ?? {})));
      if (unknownArgs.length > 0) throw new SourceError(`${operationName} has no param ${unknownArgs.join(', ')}.`, { status: BAD_REQUEST, isRetryable: false });
      const startedAt = performance.now();
      const rows = await operation.run(args, context(signal));
      return { rows: rows.slice(0, rowCap), truncated: rows.length > rowCap, ms: performance.now() - startedAt };
    },
    async safetyCheck({ signal }) {
      await declaration.check?.(context(signal));
      return { ok: true, user: declaration.service, problems: [] };
    },
    close: async () => {},
  };
}
