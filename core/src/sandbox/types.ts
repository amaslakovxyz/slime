// The SandboxRunner port: where generated shaping code runs (C3). Core builds its own
// QuickJS runner (quickjs/, §5) unless the host injects one to share across engines
// (createSlime's and crystallize's `runner` option).
export interface SandboxLimits {
  timeoutMs: number;
  memoryBytes: number;
}

export interface ShapeJob {
  /** Source of `function shape(rows, input)`; it runs with no I/O. */
  code: string;
  rows: unknown[];
  input: Record<string, unknown>;
}

export interface SandboxRunner {
  run(job: ShapeJob, limits: SandboxLimits): Promise<unknown>;
  close(): Promise<void>;
}
