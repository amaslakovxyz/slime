// Groq (OpenAI-compatible chat API) generator and reviewer. Same instructions and
// the same output validation as the Claude path, so the bench compares models, not prompts.
import type { z } from 'zod';
import { config } from './config.js';
import { SlimeError } from './errors.js';
import { buildUserMessage, type GenerationRequest, type GenerationResult, type Generator } from './generator.js';
import { ARTIFACT_FORMAT, ArtifactSchema, INSTRUCTIONS, REVIEW_FORMAT } from './prompts.js';
import { REVIEW_INSTRUCTIONS, ReviewSchema, buildReviewMessage, type ReviewRequest, type ReviewResult, type Reviewer } from './review.js';

const BASE_URL = 'https://api.groq.com/openai/v1';

const MAX_RATE_LIMIT_RETRIES = 6;
const MAX_WAIT_MS = 65_000;
const MAX_TRANSIENT_RETRIES = 2; // dropped connections, invalid-JSON replies, 5xx

function apiKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('SLIME_PROVIDER=groq but GROQ_API_KEY is not set in sandbox/.env.');
  return key;
}

interface JsonCall<T> {
  model: string;
  effort: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  timeoutMs: number;
  label: string;
}

/** One chat completion in JSON mode, validated against `schema`. Waits out 429s. */
async function callGroqJson<T>(call: JsonCall<T>) {
  const body = {
    model: call.model,
    messages: [
      { role: 'system', content: call.system },
      { role: 'user', content: call.user },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_completion_tokens: 8000,
    // gpt-oss models reason before answering; effort trades speed for care.
    ...(call.model.startsWith('openai/gpt-oss') ? { reasoning_effort: call.effort } : {}),
  };

  let waitMs = 0;
  let transientRetries = 0;
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(call.timeoutMs),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') throw new SlimeError('GENERATION_TIMEOUT', `${call.label} took too long.`, true);
      // Dropped connections ("fetch failed") happen; one quick retry.
      if (transientRetries++ < MAX_TRANSIENT_RETRIES) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw new SlimeError('GENERATION_FAILED', `Could not reach Groq: ${(err as Error).message}`, true);
    }
    const ms = performance.now() - started;

    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      // Free tier: wait out the limit. The wait is reported separately, not as model time.
      const wait = Math.min(retryAfterMs(res), MAX_WAIT_MS);
      console.warn(`[groq] ${call.label}: rate limited, waiting ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
      waitMs += wait;
      continue;
    }
    if (res.status === 401) throw new SlimeError('GENERATION_FAILED', 'Groq rejected the API key. Check GROQ_API_KEY in sandbox/.env.');
    if (res.status === 429) throw new SlimeError('GENERATION_RATE_LIMITED', 'Groq rate limit reached.', true);
    if (!res.ok) {
      const text = await res.text();
      // In JSON mode Groq rejects replies that aren't valid JSON; sampling again usually works.
      const badJson = res.status === 400 && text.includes('json_validate_failed');
      if ((badJson || res.status >= 500) && transientRetries++ < MAX_TRANSIENT_RETRIES) continue;
      throw new SlimeError('GENERATION_FAILED', `Groq error ${res.status}: ${text.slice(0, 300)}`, badJson || res.status >= 500);
    }

    const data = (await res.json()) as {
      choices: { message: { content: string | null }; finish_reason: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const choice = data.choices[0];
    if (choice.finish_reason === 'length') throw new SlimeError('GENERATION_FAILED', `${call.label}: reply was cut off.`, true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(choice.message.content ?? '');
    } catch {
      throw new SlimeError('GENERATION_FAILED', `${call.label}: the model did not return valid JSON.`, true);
    }
    const result = call.schema.safeParse(parsed);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
      throw new SlimeError('GENERATION_FAILED', `${call.label}: the model's JSON has wrong or missing fields: ${paths}`, true);
    }
    return {
      value: result.data,
      ms,
      waitMs,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };
  }
}

export class GroqGenerator implements Generator {
  constructor(private readonly schemaText: string) {
    apiKey(); // fail at startup, not on the first request
  }

  async generate(req: GenerationRequest, timeoutMs: number): Promise<GenerationResult> {
    const r = await callGroqJson({
      model: config.model,
      effort: config.effort,
      system: `${INSTRUCTIONS}\n\n${ARTIFACT_FORMAT}\n\n${this.schemaText}`,
      user: buildUserMessage(req),
      schema: ArtifactSchema,
      timeoutMs,
      label: 'generation',
    });
    return { artifact: r.value, ms: r.ms, waitMs: r.waitMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens };
  }
}

export class GroqReviewer implements Reviewer {
  readonly model = config.reviewModel;

  constructor(private readonly schemaText: string) {
    apiKey();
  }

  async review(req: ReviewRequest, timeoutMs: number): Promise<ReviewResult> {
    const r = await callGroqJson({
      model: this.model,
      effort: config.reviewEffort,
      system: `${REVIEW_INSTRUCTIONS}\n\n${REVIEW_FORMAT}\n\n${this.schemaText}`,
      user: buildReviewMessage(req),
      schema: ReviewSchema,
      timeoutMs,
      label: 'review',
    });
    return { ...r.value, ms: r.ms, waitMs: r.waitMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  }
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 + 250 : 10_000;
}
