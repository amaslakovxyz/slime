// Groq (OpenAI-compatible chat API) generator. Same instructions and the same
// output validation as the Claude generator, so the bench compares models, not prompts.
import { config } from './config.js';
import { SlimeError } from './errors.js';
import { sha256 } from './fingerprint.js';
import {
  ArtifactSchema,
  INSTRUCTIONS,
  buildUserMessage,
  type GenerationRequest,
  type GenerationResult,
  type Generator,
} from './generator.js';

const BASE_URL = 'https://api.groq.com/openai/v1';

// JSON mode only guarantees valid JSON, so the expected keys are spelled out here
// and the reply is validated with the same zod schema the Claude path uses.
const JSON_FORMAT = `Reply with ONLY a JSON object with exactly these keys:
{"unsatisfiable": string or null, "sql": string, "params": string[], "shapeJs": string or null, "assumptions": string[]}`;

export const GROQ_PROMPT_HASH = sha256(`groq\n${INSTRUCTIONS}\n${JSON_FORMAT}`).slice(0, 16);

const MAX_RATE_LIMIT_RETRIES = 4;
const MAX_WAIT_MS = 65_000;

export class GroqGenerator implements Generator {
  private readonly apiKey: string;

  constructor(private readonly schemaText: string) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('SLIME_PROVIDER=groq but GROQ_API_KEY is not set in sandbox/.env.');
    this.apiKey = key;
  }

  async generate(req: GenerationRequest, timeoutMs: number): Promise<GenerationResult> {
    const body = {
      model: config.model,
      messages: [
        { role: 'system', content: `${INSTRUCTIONS}\n\n${JSON_FORMAT}\n\n${this.schemaText}` },
        { role: 'user', content: buildUserMessage(req) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_completion_tokens: 4000,
      // gpt-oss models reason before answering; keep it short for speed.
      ...(config.model.startsWith('openai/gpt-oss') ? { reasoning_effort: config.effort } : {}),
    };

    let waitMs = 0;
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if ((err as Error).name === 'TimeoutError') throw new SlimeError('GENERATION_TIMEOUT', 'Code generation took too long.', true);
        throw new SlimeError('GENERATION_FAILED', `Could not reach Groq: ${(err as Error).message}`, true);
      }
      const ms = performance.now() - started;

      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        // Free tier: wait out the limit. The wait is reported separately, not as model time.
        const wait = Math.min(retryAfterMs(res), MAX_WAIT_MS);
        console.warn(`[groq] rate limited, waiting ${Math.round(wait / 1000)}s`);
        await new Promise((r) => setTimeout(r, wait));
        waitMs += wait;
        continue;
      }
      if (res.status === 401) {
        throw new SlimeError('GENERATION_FAILED', 'Groq rejected the API key. Check GROQ_API_KEY in sandbox/.env.');
      }
      if (res.status === 429) throw new SlimeError('GENERATION_RATE_LIMITED', 'Groq rate limit reached.', true);
      if (!res.ok) {
        const text = await res.text();
        throw new SlimeError('GENERATION_FAILED', `Groq error ${res.status}: ${text.slice(0, 300)}`, res.status >= 500);
      }

      const data = (await res.json()) as {
        choices: { message: { content: string | null }; finish_reason: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      };
      const choice = data.choices[0];
      if (choice.finish_reason === 'length') {
        throw new SlimeError('GENERATION_FAILED', 'The model returned an incomplete handler.', true);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(choice.message.content ?? '');
      } catch {
        throw new SlimeError('GENERATION_FAILED', 'The model did not return valid JSON.', true);
      }
      const artifact = ArtifactSchema.safeParse(parsed);
      if (!artifact.success) {
        throw new SlimeError('GENERATION_FAILED', `The model's JSON is missing fields: ${artifact.error.issues.map((i) => i.path.join('.')).join(', ')}`, true);
      }
      return {
        artifact: artifact.data,
        ms,
        waitMs,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      };
    }
  }
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 + 250 : 10_000;
}
