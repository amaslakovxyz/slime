// The one thing a model provider implements. modelRoles() (roles.ts) turns a
// client into the Generator, Reviewer and Optimizer, so prompts, schemas and
// prompt hashing are shared by every provider.
import type { z } from 'zod';
import type { ModelUsage } from './types.js';

/**
 * 'native': the provider enforces the reply schema itself (structured output).
 * 'prompt': the JSON format is spelled out in the instructions; validate the
 * reply with parseJsonReply.
 */
export type OutputMode = 'native' | 'prompt';

export interface ModelCall<T> {
  instructions: string;
  /** The dictionary: the same for every call, so a provider may cache it with the instructions. */
  context?: string;
  message: string;
  schema: z.ZodType<T>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Names the call in error messages, for example "generation". */
  label: string;
}

export interface ModelReply<T> {
  value: T;
  usage: ModelUsage;
}

/**
 * Errors must be SlimeErrors: GENERATION_RATE_LIMITED, GENERATION_TIMEOUT or
 * GENERATION_FAILED, with `retryable` set when another attempt may succeed.
 */
export interface ModelClient {
  /** Part of every prompt hash, so switching provider regenerates handlers (§4.7). */
  readonly provider: string;
  readonly model: string;
  readonly outputMode: OutputMode;
  call<T>(request: ModelCall<T>): Promise<ModelReply<T>>;
}
