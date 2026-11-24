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
      // An empty key would come back as a 401, which reads as a wrong key, not a missing one.
      // JS callers may pass an unset env var, so undefined counts as missing too.
      if (!apiKey?.trim()) throw new SlimeError('GENERATION_FAILED', 'No Claude API key is set.');
      const startedAt = performance.now();
      const timer = requestTimer();
      let response;
      try {
        response = await client.withOptions({ fetch: timer.fetch }).beta.messages.parse(
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
      const waitMs = timer.waitMs();
      const usage = { ms: performance.now() - startedAt - waitMs, waitMs, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      return { value: response.parsed_output, usage };
    },
  };
}

interface RequestTimer {
  fetch: typeof fetch;
  /** The gaps between one call's HTTP requests: the SDK's backoff before each retry. */
  waitMs: () => number;
}

// The SDK retries 429s and 5xx itself (maxRetries) and sleeps in between; the time between one
// request's response and the next request is that sleep, so it is reported as a wait, not model time.
function requestTimer(): RequestTimer {
  let lastEndedAt: number | undefined;
  let waitMs = 0;
  const timedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const startedAt = performance.now();
    if (lastEndedAt !== undefined) waitMs += startedAt - lastEndedAt;
    try {
      // Read at call time, as the SDK reads it at build time: tests stub globalThis.fetch.
      return await globalThis.fetch(input, init);
    } finally {
      lastEndedAt = performance.now();
    }
  };
  return { fetch: timedFetch as typeof fetch, waitMs: () => waitMs };
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
