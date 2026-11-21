import { GENERATION_INSTRUCTIONS, OPTIMIZE_INSTRUCTIONS, REVIEW_INSTRUCTIONS, generationMessage, optimizeMessage, promptHash, reviewMessage } from '../prompts.js';
import { ArtifactSchema, OptimizedCodeSchema, ReviewVerdictSchema } from '../schemas.js';
import type { Generator, Optimizer, Reviewer } from '../types.js';
import { structuredCaller, type ClaudeOptions } from './structured-call.js';

const PROVIDER = 'claude';

export function claudeGenerator(options: ClaudeOptions): Generator {
  const call = structuredCaller(options);
  return {
    model: options.model,
    promptHash: promptHash(PROVIDER, GENERATION_INSTRUCTIONS),
    async generate(request, { timeoutMs, signal }) {
      const reply = await call({
        instructions: GENERATION_INSTRUCTIONS,
        context: request.context,
        message: generationMessage(request),
        schema: ArtifactSchema,
        timeoutMs,
        label: 'generation',
        ...(signal ? { signal } : {}),
      });
      return { artifact: reply.value, ...reply.usage };
    },
  };
}

export function claudeReviewer(options: ClaudeOptions): Reviewer {
  const call = structuredCaller(options);
  return {
    model: options.model,
    async review(request, { timeoutMs, signal }) {
      const reply = await call({
        instructions: REVIEW_INSTRUCTIONS,
        context: request.context,
        message: reviewMessage(request),
        schema: ReviewVerdictSchema,
        timeoutMs,
        label: 'review',
        ...(signal ? { signal } : {}),
      });
      return { ...reply.value, ...reply.usage };
    },
  };
}

/** Runs offline in the crystallize job, so a stronger model is usually worth it. */
export function claudeOptimizer(options: ClaudeOptions): Optimizer {
  const call = structuredCaller(options);
  return {
    model: options.model,
    async optimize(request, { timeoutMs, signal }) {
      const reply = await call({
        instructions: OPTIMIZE_INSTRUCTIONS,
        message: optimizeMessage(request),
        schema: OptimizedCodeSchema,
        timeoutMs,
        label: 'crystal optimize',
        ...(signal ? { signal } : {}),
      });
      return { code: reply.value, ...reply.usage };
    },
  };
}
