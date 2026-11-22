// Records a request's LayerSpans while the engine answers it (request trace design T1–T4).
import { SlimeError } from '../shared/errors.js';
import { layerOfError, type LayerId, type LayerSpan, type LayerStatus } from '../shared/trace.js';
import type { Execution } from './execution/execute.js';
import { repairMessage } from './generation/repair-message.js';

const NOTE_MAX = 200;
const MS_PRECISION = 100;

export interface SpanExtra {
  ms?: number | undefined;
  note?: string | undefined;
  attempt?: number | undefined;
}

export interface TimeOptions<T> {
  attempt?: number | undefined;
  /** The pass note, from the layer's result. */
  note?: (result: T) => string | undefined;
}

export class Trace {
  readonly spans: LayerSpan[] = [];

  add(layer: LayerId, status: LayerStatus, { ms, note, attempt }: SpanExtra = {}): void {
    const span: LayerSpan = { layer, status };
    if (ms !== undefined) span.ms = Math.round(ms * MS_PRECISION) / MS_PRECISION;
    if (note) span.note = note.slice(0, NOTE_MAX);
    if (attempt !== undefined) span.attempt = attempt;
    this.spans.push(span);
  }

  /** Runs one layer's work: a pass span with its time, or a value-free stop span, then the same error again. */
  async time<T>(layer: LayerId, work: () => T | Promise<T>, { attempt, note }: TimeOptions<T> = {}): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await work();
      this.add(layer, 'pass', { ms: performance.now() - startedAt, note: note?.(result), attempt });
      return result;
    } catch (error) {
      this.add(layer, 'stop', { ms: performance.now() - startedAt, note: stopNote(error), attempt });
      throw error;
    }
  }

  /** A run that passed: the steps, the shape and the output check. Counts only. */
  addExecution(execution: Execution, attempt?: number): void {
    const { steps, truncated, runMs, shapeMs } = execution;
    const ran = steps ? `${steps.length} step${steps.length === 1 ? '' : 's'} · ${steps.reduce((n, s) => n + s.rows, 0)} rows` : '1 query';
    this.add('execute', 'pass', { ms: runMs, note: truncated ? `${ran} · cut at the row cap` : ran, attempt });
    if (shapeMs > 0) this.add('shape', 'pass', { ms: shapeMs, note: 'shape ran', attempt });
    else this.add('shape', 'skip', { note: 'no shape function', attempt });
    this.add('output', 'pass', { note: 'matches the output shape', attempt });
  }

  /** A failure inside a layer that was not timed: a stop span at the error's layer. */
  fail(error: unknown, attempt?: number): void {
    const layer = error instanceof SlimeError ? layerOfError(error) : 'execute';
    this.add(layer, 'stop', { note: stopNote(error), attempt });
  }

  /**
   * The error to throw for this request: a copy that carries this request's spans (ending in a
   * stop) and its key. A copy, because coalesced requests share one error object.
   */
  attach(error: unknown, handlerKey?: string): unknown {
    if (!(error instanceof SlimeError)) return error;
    const layer = layerOfError(error);
    const last = this.spans.at(-1);
    if (!(last?.status === 'stop' && last.layer === layer)) this.add(layer, 'stop', { note: stopNote(error) });
    const copy = new SlimeError(error.code, error.message, { retryable: error.retryable, ...(error.details ? { details: error.details } : {}) });
    if (error.stack) copy.stack = error.stack;
    copy.trace = [...this.spans];
    if (handlerKey) copy.handlerKey = handlerKey;
    return copy;
  }
}

function stopNote(error: unknown): string {
  return error instanceof SlimeError ? repairMessage(error) : 'unexpected error';
}
