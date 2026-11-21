// Groq's OpenAI-compatible chat API in JSON mode, through fetch: no SDK to install.
import type { z } from 'zod';
import { SlimeError } from '../../shared/errors.js';
import type { ModelUsage } from '../types.js';

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface GroqOptions {
  /** Passed explicitly: core never reads GROQ_API_KEY itself. */
  apiKey: string;
  model: string;
  /** Only for models that reason before answering (openai/gpt-oss-*). */
  reasoningEffort?: ReasoningEffort;
}

export interface JsonCall<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  timeoutMs: number;
  label: string;
}

export interface JsonReply<T> {
  value: T;
  usage: ModelUsage;
}

interface ChatCompletion {
  choices: { message: { content: string | null }; finish_reason: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_COMPLETION_TOKENS = 8_000;
// The free tier rate-limits often; waits are reported as waitMs, not model time.
const MAX_RATE_LIMIT_RETRIES = 6;
const MAX_WAIT_MS = 65_000;
const DEFAULT_WAIT_MS = 10_000;
const RETRY_AFTER_MARGIN_MS = 250;
// Dropped connections, invalid-JSON replies and 5xx usually pass on a second try.
const MAX_TRANSIENT_RETRIES = 2;
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const REASONING_MODEL_PREFIX = 'openai/gpt-oss';

export async function callGroqJson<T>(options: GroqOptions, call: JsonCall<T>): Promise<JsonReply<T>> {
  let waitMs = 0;
  let transientRetries = 0;
  for (let rateLimitRetries = 0; ; ) {
    const startedAt = performance.now();
    const response = await post(options, call).catch((error: unknown) => {
      if ((error as Error).name === 'TimeoutError') throw new SlimeError('GENERATION_TIMEOUT', `${call.label} took too long.`, { retryable: true });
      if (transientRetries++ >= MAX_TRANSIENT_RETRIES) throw new SlimeError('GENERATION_FAILED', `Could not reach Groq: ${(error as Error).message}`, { retryable: true });
      return undefined;
    });
    if (!response) continue;
    if (response.status === HTTP_TOO_MANY_REQUESTS && rateLimitRetries++ < MAX_RATE_LIMIT_RETRIES) {
      const delayMs = Math.min(retryAfterMs(response), MAX_WAIT_MS);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      waitMs += delayMs;
      continue;
    }
    const failure = await failureOf(response);
    if (failure?.isTransient && transientRetries++ < MAX_TRANSIENT_RETRIES) continue;
    if (failure) throw failure.error;
    const completion = (await response.json()) as ChatCompletion;
    const usage = { ms: performance.now() - startedAt, waitMs, inputTokens: completion.usage?.prompt_tokens ?? 0, outputTokens: completion.usage?.completion_tokens ?? 0 };
    return { value: parseReply(completion, call), usage };
  }
}

function post({ apiKey, model, reasoningEffort }: GroqOptions, { system, user, timeoutMs }: JsonCall<unknown>): Promise<Response> {
  const isReasoningModel = model.startsWith(REASONING_MODEL_PREFIX);
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    ...(isReasoningModel && reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
  return fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

interface Failure {
  error: SlimeError;
  isTransient: boolean;
}

async function failureOf(response: Response): Promise<Failure | undefined> {
  if (response.ok) return undefined;
  if (response.status === HTTP_UNAUTHORIZED) return { error: new SlimeError('GENERATION_FAILED', 'Groq rejected the API key.'), isTransient: false };
  if (response.status === HTTP_TOO_MANY_REQUESTS) {
    return { error: new SlimeError('GENERATION_RATE_LIMITED', 'Groq rate limit reached.', { retryable: true }), isTransient: false };
  }
  const text = await response.text();
  // In JSON mode Groq rejects replies that aren't valid JSON; sampling again usually works.
  const isTransient = text.includes('json_validate_failed') || response.status >= HTTP_SERVER_ERROR;
  return { error: new SlimeError('GENERATION_FAILED', `Groq error ${response.status}: ${text.slice(0, 300)}`, { retryable: isTransient }), isTransient };
}

function parseReply<T>(completion: ChatCompletion, { schema, label }: JsonCall<T>): T {
  const choice = completion.choices[0];
  if (choice?.finish_reason === 'length') throw new SlimeError('GENERATION_FAILED', `${label}: the reply was cut off.`, { retryable: true });
  let json: unknown;
  try {
    json = JSON.parse(choice?.message.content ?? '');
  } catch {
    throw new SlimeError('GENERATION_FAILED', `${label}: the model did not return valid JSON.`, { retryable: true });
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues.map(({ path }) => path.join('.') || '(root)').join(', ');
  throw new SlimeError('GENERATION_FAILED', `${label}: the model's JSON has wrong or missing fields: ${fields}`, { retryable: true });
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 + RETRY_AFTER_MARGIN_MS : DEFAULT_WAIT_MS;
}
