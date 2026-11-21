import { GENERATION_INSTRUCTIONS, REVIEW_INSTRUCTIONS, generationMessage, promptHash, reviewMessage } from '../models/prompts.js';
import { ArtifactSchema, ReviewVerdictSchema } from '../models/schemas.js';
import type { Generator, Reviewer } from '../ports.js';
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
