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

export interface SandboxRunner {
  run(job: ShapeJob, limits: SandboxLimits): Promise<unknown>;
  close(): Promise<void>;
}
