// The SandboxRunner port: where generated shaping code runs (C3). Core builds its own
// QuickJS runner (quickjs/, §5) unless the host injects one to share across engines
// (createSlime's and crystallize's `runner` option).
export interface SandboxLimits {
  timeoutMs: number;
  memoryBytes: number;
}

/** Crystal: the rows; a handler: { [stepName]: rows } (MS3). Both are embedded the same way. */
export type ShapeInput = unknown[] | Readonly<Record<string, unknown[]>>;

export interface ShapeJob {
  /** Source of `function shape(data, input)`, or `function shape(rows, input)` for Crystal; it runs with no I/O. */
  code: string;
  rows: ShapeInput;
  input: Record<string, unknown>;
}

/** Filled in by the runner when the caller passes it; a runner that measures nothing leaves it at 0. */
export interface SandboxStats {
  /** Waiting for a worker before the code ran: starting one, or a free one in a busy pool. */
  waitMs: number;
}

export interface SandboxRunner {
  run(job: ShapeJob, limits: SandboxLimits, stats?: SandboxStats): Promise<unknown>;
  close(): Promise<void>;
}
