// The optimizing agent: rewrites a Liquid handler into Crystal form.
//
// It sees only code: the SQL, the parameter names, the shaping function, the
// requested output shape and the input names and types. Never the request text
// (so a crafted intent repeated until promotion can't instruct it) and never data.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { config } from '../config.js';
import type { CrystalCode } from './module.js';

export const OptimizedSchema = z.object({
  sql: z.string(),
  params: z.array(z.string()),
  shape: z.string().nullable(),
  notes: z.array(z.string()),
});

export interface OptimizeRequest {
  sql: string;
  params: string[];
  shapeJs: string | null;
  output: unknown;
  inputSig: Record<string, string>;
}

export interface Optimizer {
  readonly model: string;
  optimize(req: OptimizeRequest, timeoutMs: number): Promise<CrystalCode & { notes: string[] }>;
}

export const OPTIMIZE_INSTRUCTIONS = `You convert a verified, read-only data handler into its Crystal form. Crystal code runs inside the server with no sandbox, so it must follow strict rules, and it must return exactly the same result as the original for every input.

You get the handler's PostgreSQL query (inputs bound as $1, $2, ...), the input parameter name for each placeholder, its JavaScript shaping function (or null when the SQL rows are the output), the JSON output shape, and the input names and types.

Return:
- sql: one PostgreSQL SELECT. Keep the same results, row order, rounding, null handling and filters.
- params: the input name for each $n placeholder, in order.
- shape: null when the SQL rows already are the output (a list of flat objects whose column aliases are exactly the output keys). Otherwise the source of exactly one function: function shape(rows, input) { ... }.
- notes: short notes on what you changed and why. [] if nothing.

Optimize where it is safe: fold renaming and simple formatting into SQL aliases so shape can be null; drop work whose result is unused. Do not change what the handler means. If unsure, keep the original logic.

Rules for shape (the server rejects anything else):
- Plain synchronous function. No async, generators, classes, or this.
- Only these globals: Math, Object.keys/values/entries/fromEntries, Array.isArray/from/of, JSON.stringify/parse, Number(...), Number.isInteger/isFinite/isNaN/parseFloat/parseInt, String(...), Boolean(...), new Date(...), Date.UTC/parse, new Map(), new Set(), Intl formatters, parseInt, parseFloat, isNaN, isFinite.
- Loops: only for...of and array methods (map, filter, reduce, ...). No while, do...while, for(;;), for...in, or labels.
- No computed property access with a variable key (obj[key]); use a Map for grouping. obj[0] and obj["literal"] are fine.
- Never use constructor, prototype, __proto__, defineProperty, or assign to or delete properties of globals.`;

function buildMessage(req: OptimizeRequest): string {
  return [
    `SQL:\n${req.sql}`,
    `params ($1, $2, ...): ${JSON.stringify(req.params)}`,
    `shape: ${req.shapeJs ?? 'null'}`,
    `Output shape: ${JSON.stringify(req.output)}`,
    `Input parameters (name: type): ${JSON.stringify(req.inputSig)}`,
  ].join('\n');
}

export class ClaudeOptimizer implements Optimizer {
  // The stronger model: this job runs offline, so quality matters more than speed.
  readonly model = config.provider === 'claude' ? config.reviewModel : 'claude-opus-5-5';
  private client = new Anthropic({ maxRetries: 1 });

  async optimize(req: OptimizeRequest, timeoutMs: number) {
    const response = await this.client.beta.messages.parse(
      {
        model: this.model,
        max_tokens: 16000,
        system: OPTIMIZE_INSTRUCTIONS,
        messages: [{ role: 'user', content: buildMessage(req) }],
        output_config: { format: betaZodOutputFormat(OptimizedSchema), effort: config.reviewEffort },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { timeout: timeoutMs },
    );
    if (response.stop_reason === 'refusal' || !response.parsed_output) throw new Error('optimizer returned no code');
    return response.parsed_output;
  }
}

export class GroqOptimizer implements Optimizer {
  readonly model = config.provider === 'groq' ? config.reviewModel : 'openai/gpt-oss-120b';

  async optimize(req: OptimizeRequest, timeoutMs: number) {
    const { callGroqJson } = await import('../generator-groq.js');
    const r = await callGroqJson({
      model: this.model,
      effort: config.reviewEffort,
      system: `${OPTIMIZE_INSTRUCTIONS}\n\nReply with ONLY a JSON object with exactly these keys:\n{"sql": string, "params": string[], "shape": string or null, "notes": string[]}`,
      user: buildMessage(req),
      schema: OptimizedSchema,
      timeoutMs,
      label: 'crystal optimize',
    });
    return r.value;
  }
}

/**
 * Defaults to the configured provider. Offline (or "none") means no model: the
 * Liquid code is moved out of the sandbox unchanged, if it passes the allowlist.
 */
export function createOptimizer(name: string = config.provider): Optimizer | null {
  if (name === 'claude') return new ClaudeOptimizer();
  if (name === 'groq') return new GroqOptimizer();
  if (name === 'offline' || name === 'none') return null;
  throw new Error(`unknown optimizer "${name}" (use claude, groq or none)`);
}
