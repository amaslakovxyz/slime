// Background review of a Gas handler before it may become Liquid.
// A second, stronger pass reads the request and the generated code (never row data)
// and decides whether the code answers the request correctly for any input values.
// Its job is to catch answers that pass every automatic check but mean the wrong
// thing, e.g. ranking the most active accounts as the highest churn risk.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { config } from './config.js';
import { SlimeError } from './errors.js';
import type { Artifact } from './generator.js';

export const ReviewSchema = z.object({
  verdict: z.enum(['approve', 'reject']),
  problems: z.array(z.string()),
});
export type ReviewVerdict = z.infer<typeof ReviewSchema>;

export interface ReviewRequest {
  intent: string;
  inputSig: Record<string, string>;
  output: unknown;
  artifact: Artifact;
}

export interface ReviewResult extends ReviewVerdict {
  ms: number;
  waitMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Reviewer {
  readonly model: string;
  review(req: ReviewRequest, timeoutMs: number): Promise<ReviewResult>;
}

export const REVIEW_INSTRUCTIONS = `You review data handlers that another model generated for Slime, a backend that answers frontend data requests with read-only SQL.

You get the database schema, the caller's request (intent, input parameter names and types, output shape) and the generated handler: a PostgreSQL query, the input parameter mapped to each $n placeholder, an optional JavaScript shape(rows, input) function, and the generator's stated assumptions.

Decide whether the handler answers the request correctly for ANY input values. Check:
- Does the SQL compute what the intent asks? Direction of rankings and sorts ("top", "highest", "most at risk"), filters, date boundaries, which rows count.
- Are vague terms interpreted sensibly? Check the direction of any computed score: a score named after an outcome (a risk, likelihood or priority) must increase as that outcome becomes more likely, and rankings must put the highest score first when the intent says "top".
- Do joins multiply rows and inflate counts or sums?
- Are input parameters used where the intent implies them, instead of fixed values?
- Does shape() return exactly the requested output for any rows?

Approve if the handler is correct or a reasonable interpretation of an ambiguous intent. Reject only for errors that give wrong answers. For each problem, say what is wrong and how to fix it, concretely.`;

export function buildReviewMessage(req: ReviewRequest): string {
  return [
    `Intent: ${req.intent}`,
    `Input parameters (name: type): ${JSON.stringify(req.inputSig)}`,
    `Output shape: ${JSON.stringify(req.output)}`,
    '',
    'Generated handler:',
    `SQL:\n${req.artifact.sql}`,
    `params ($1, $2, ...): ${JSON.stringify(req.artifact.params)}`,
    `shapeJs: ${req.artifact.shapeJs ?? 'null (rows are returned as-is)'}`,
    `Generator's assumptions: ${req.artifact.assumptions.length ? req.artifact.assumptions.join(' | ') : 'none'}`,
  ].join('\n');
}

export class ClaudeReviewer implements Reviewer {
  readonly model = config.reviewModel;
  private client = new Anthropic({ maxRetries: 1 });

  constructor(private readonly schemaText: string) {}

  async review(req: ReviewRequest, timeoutMs: number): Promise<ReviewResult> {
    const started = performance.now();
    let response;
    try {
      response = await this.client.beta.messages.parse(
        {
          model: this.model,
          max_tokens: 16000,
          system: [
            { type: 'text', text: REVIEW_INSTRUCTIONS },
            { type: 'text', text: this.schemaText, cache_control: { type: 'ephemeral' } },
          ],
          messages: [{ role: 'user', content: buildReviewMessage(req) }],
          output_config: { format: betaZodOutputFormat(ReviewSchema), effort: config.reviewEffort },
          // If the review model declines a request, the API re-runs it on a fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { timeout: timeoutMs },
      );
    } catch (err) {
      throw new SlimeError('GENERATION_FAILED', `Review call failed: ${(err as Error).message}`, true);
    }
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      throw new SlimeError('GENERATION_FAILED', 'The reviewer returned no verdict.', true);
    }
    return {
      ...response.parsed_output,
      ms: performance.now() - started,
      waitMs: 0,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}
