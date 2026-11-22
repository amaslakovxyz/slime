// A request's walk through the harness: one span per layer it reached (request trace design T1–T4).
// Types and the error → layer map only; the engine records spans (engine/trace.ts).
import type { ErrorCode, SlimeError } from './errors.js';

/** Every layer, in the order a request meets them. Hosts add `edge`; the engine records the rest. */
export const LAYER_IDS = ['edge', 'key', 'route', 'limits', 'generate', 'lint', 'cost', 'execute', 'shape', 'output', 'cache', 'review'] as const;
export type LayerId = (typeof LAYER_IDS)[number];
export type LayerStatus = 'pass' | 'skip' | 'stop' | 'pending';

/** What one layer did with the request. Notes carry counts, names and limits, never input values or rows. */
export interface LayerSpan {
  layer: LayerId;
  status: LayerStatus;
  ms?: number;
  note?: string;
  /** 1-based generation attempt, on the layers a repair repeats (generate … output). */
  attempt?: number;
}

const LAYER_BY_CODE: Record<ErrorCode, LayerId> = {
  INVALID_REQUEST: 'key',
  HANDLER_NOT_FOUND: 'route',
  GENERATION_RATE_LIMITED: 'limits',
  GENERATION_FAILED: 'generate',
  GENERATION_TIMEOUT: 'generate',
  INTENT_UNSATISFIABLE: 'generate',
  WRITE_REFUSED: 'lint',
  INVALID_HANDLER: 'lint',
  QUERY_TOO_LARGE: 'cost',
  QUERY_TOO_EXPENSIVE: 'cost',
  QUERY_ERROR: 'execute',
  EXECUTION_TIMEOUT: 'execute',
  SOURCE_ERROR: 'execute',
  ACCESS_DENIED: 'execute',
  SANDBOX_ERROR: 'shape',
  SHAPE_MISMATCH: 'output',
};
// R6 (execution/output-limit.ts) reuses INVALID_HANDLER after the run; its message names input.limit.
const R6_MESSAGE = /input\.limit/;

/** The layer that refused a request with this error. */
export function layerOfError(error: SlimeError): LayerId {
  if (error.code === 'WRITE_REFUSED') {
    const enforcedBy = error.details?.['enforcedBy'];
    return enforcedBy === 'model' ? 'generate' : enforcedBy === 'lint' ? 'lint' : 'execute';
  }
  if (error.code === 'INVALID_HANDLER' && R6_MESSAGE.test(error.message)) return 'output';
  return LAYER_BY_CODE[error.code];
}
