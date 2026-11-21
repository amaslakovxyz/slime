// Just enough SSM for the tenant cache: GetParametersByPath (one level below the
// path, as without Recursive) in pages of `pageSize`, and a count of calls.
import type { GetParametersByPathCommand, GetParametersByPathCommandOutput } from '@aws-sdk/client-ssm';
import type { SsmPort } from '../src/tenants.js';

export class FakeSsm implements SsmPort {
  /** Parameter name -> value. */
  readonly parameters = new Map<string, string>();
  calls = 0;
  /** When set, every call throws this (an SSM throttle, say). */
  failWith: Error | undefined;
  readonly #pageSize: number;

  constructor(pageSize = 10) {
    this.#pageSize = pageSize;
  }

  /** Puts every value under `path` (which ends with '/'). */
  putAll(path: string, values: Record<string, string>): void {
    for (const [name, value] of Object.entries(values)) this.parameters.set(`${path}${name}`, value);
  }

  deleteAll(path: string): void {
    for (const name of [...this.parameters.keys()]) if (name.startsWith(path)) this.parameters.delete(name);
  }

  async send(command: GetParametersByPathCommand): Promise<GetParametersByPathCommandOutput> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    const { Path = '', NextToken } = command.input;
    const matching = [...this.parameters.entries()]
      .filter(([name]) => name.startsWith(Path) && !name.slice(Path.length).includes('/'))
      .sort(([a], [b]) => a.localeCompare(b));
    const start = NextToken ? Number(NextToken) : 0;
    const page = matching.slice(start, start + this.#pageSize);
    const hasMore = start + this.#pageSize < matching.length;
    return {
      Parameters: page.map(([Name, Value]) => ({ Name, Value })),
      ...(hasMore ? { NextToken: String(start + this.#pageSize) } : {}),
      $metadata: {},
    };
  }
}
