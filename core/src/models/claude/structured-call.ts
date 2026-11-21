import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { SlimeError } from '../../shared/errors.js';
import type { ModelUsage } from '../types.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeOptions {
  /** Passed explicitly: core never reads ANTHROPIC_API_KEY itself. */
  apiKey: string;
  model: string;
  effort?: Effort;
  maxRetries?: number;
}

export interface StructuredCall<T> {
  instructions: string;
  /** The dictionary; it is the same for every call, so it is cached with the instructions. */
  context?: string;
  message: string;
  schema: z.ZodType<T>;
  timeoutMs: number;
  signal?: AbortSignal;
  label: string;
}

export interface StructuredReply<T> {
  value: T;
  usage: ModelUsage;
}

export type StructuredCaller = <T>(call: StructuredCall<T>) => Promise<StructuredReply<T>>;

const MAX_TOKENS = 16_000;
const DEFAULT_MAX_RETRIES = 1;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Server-side refusal fallbacks exist only for these models; others get no fallback.
const MODELS_WITH_FALLBACKS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/** One Claude request whose reply is parsed and validated against the call's zod schema. */
export function structuredCaller({ apiKey, model, effort, maxRetries = DEFAULT_MAX_RETRIES }: ClaudeOptions): StructuredCaller {
  const client = new Anthropic({ apiKey, maxRetries });
  const fallback = MODELS_WITH_FALLBACKS.has(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {};

  return async <T>(call: StructuredCall<T>): Promise<StructuredReply<T>> => {
    const startedAt = performance.now();
    let response;
    try {
      response = await client.beta.messages.parse(
        {
          model,
          max_tokens: MAX_TOKENS,
          system: [
            { type: 'text', text: call.instructions },
            ...(call.context ? [{ type: 'text' as const, text: call.context, cache_control: { type: 'ephemeral' as const } }] : []),
          ],
          messages: [{ role: 'user', content: call.message }],
          output_config: { format: betaZodOutputFormat(call.schema), ...(effort ? { effort } : {}) },
          ...fallback,
        },
        { timeout: call.timeoutMs, ...(call.signal ? { signal: call.signal } : {}) },
      );
    } catch (error) {
      throw toSlimeError(error, call.label);
    }
    if (response.stop_reason === 'refusal') throw new SlimeError('GENERATION_FAILED', `${call.label}: the model declined this request.`);
    if (response.stop_reason === 'max_tokens' || !response.parsed_output) {
      throw new SlimeError('GENERATION_FAILED', `${call.label}: the model returned an incomplete reply.`, { retryable: true });
    }
    const usage = { ms: performance.now() - startedAt, waitMs: 0, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    return { value: response.parsed_output, usage };
  };
}

function toSlimeError(error: unknown, label: string): SlimeError {
  if (error instanceof Anthropic.AuthenticationError) return new SlimeError('GENERATION_FAILED', 'The Claude API rejected the API key.');
  if (error instanceof Anthropic.RateLimitError) return new SlimeError('GENERATION_RATE_LIMITED', 'Claude API rate limit reached.', { retryable: true });
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new SlimeError('GENERATION_TIMEOUT', `${label} took too long.`, { retryable: true });
  if (error instanceof Anthropic.APIError) {
    const isServerError = (error.status ?? 0) >= 500;
    return new SlimeError('GENERATION_FAILED', `Claude API error ${error.status ?? ''}: ${error.message}`, { retryable: isServerError });
  }
  return new SlimeError('GENERATION_FAILED', `${label} failed: ${error instanceof Error ? error.message : String(error)}`);
}
