export type ReadyMessage = 'ready';
export const READY_MESSAGE: ReadyMessage = 'ready';

/** QuickJS's message when its deadline interrupt fires. */
export const INTERRUPTED_MESSAGE = 'interrupted';

export interface ShapeTask {
  id: number;
  /** The shaping function plus the call that serializes its result. */
  program: string;
  timeoutMs: number;
  memoryBytes: number;
}

export interface ShapeReply {
  id: number;
  isOk: boolean;
  result?: unknown;
  errorName?: string;
  errorMessage?: string;
}
