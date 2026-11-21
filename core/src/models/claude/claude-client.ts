import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { SlimeError } from '../../shared/errors.js';
import type { ModelCall, ModelClient, ModelReply } from '../model-client.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeOptions {
  /** Passed explicitly: core never reads ANTHROPIC_API_KEY itself. */
  apiKey: string;
  model: string;
  effort?: Effort;
  maxRetries?: number;
}

const PROVIDER = 'claude';
const MAX_TOKENS = 16_000;
const DEFAULT_MAX_RETRIES = 1;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Server-side refusal fallbacks exist only for these models; others get no fallback.
// The SDK throws this when the reply doesn't match the schema; sampling again usually fixes it.
const STRUCTURED_OUTPUT_MISMATCH = /^Failed to parse structured output/;
const MODELS_WITH_FALLBACKS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

// Claude's structured output enforces the reply schema, so no JSON format goes in the prompt.
export function claudeClient({ apiKey, model, effort, maxRetries = DEFAULT_MAX_RETRIES }: ClaudeOptions): ModelClient {
  const client = new Anthropic({ apiKey, maxRetries });
  const fallback = MODELS_WITH_FALLBACKS.has(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {};

  return {
    provider: PROVIDER,
    model,
    outputMode: 'native',
    async call<T>(call: ModelCall<T>): Promise<ModelReply<T>> {
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
    },
  };
}

function toSlimeError(error: unknown, label: string): SlimeError {
  if (error instanceof Anthropic.AuthenticationError) return new SlimeError('GENERATION_FAILED', 'The Claude API rejected the API key.');
  if (error instanceof Anthropic.RateLimitError) return new SlimeError('GENERATION_RATE_LIMITED', 'Claude API rate limit reached.', { retryable: true });
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new SlimeError('GENERATION_TIMEOUT', `${label} took too long.`, { retryable: true });
  if (error instanceof Error && STRUCTURED_OUTPUT_MISMATCH.test(error.message)) {
    return new SlimeError('GENERATION_FAILED', `${label}: the model's reply has wrong or missing fields.`, { retryable: true });
  }
  if (error instanceof Anthropic.APIError) {
    const isServerError = (error.status ?? 0) >= 500;
    return new SlimeError('GENERATION_FAILED', `Claude API error ${error.status ?? ''}: ${error.message}`, { retryable: isServerError });
  }
  return new SlimeError('GENERATION_FAILED', `${label} failed: ${error instanceof Error ? error.message : String(error)}`);
}
