// The SandboxRunner port: where generated shaping code runs (C3). A type only in v1:
// core always uses its own QuickJS runner (shaping/, §5).
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
