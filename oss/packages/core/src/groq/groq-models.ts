import {
  ARTIFACT_JSON_FORMAT,
  GENERATION_INSTRUCTIONS,
  REVIEW_INSTRUCTIONS,
  REVIEW_JSON_FORMAT,
  generationMessage,
  promptHash,
  reviewMessage,
} from '../models/prompts.js';
import { ArtifactSchema, ReviewVerdictSchema } from '../models/schemas.js';
import type { Generator, Reviewer } from '../ports.js';
import { callGroqJson, type GroqOptions } from './groq-client.js';

const PROVIDER = 'groq';

export function groqGenerator(options: GroqOptions): Generator {
  return {
    model: options.model,
    promptHash: promptHash(PROVIDER, GENERATION_INSTRUCTIONS, ARTIFACT_JSON_FORMAT),
    async generate(request, { timeoutMs }) {
      const reply = await callGroqJson(options, {
        system: `${GENERATION_INSTRUCTIONS}\n\n${ARTIFACT_JSON_FORMAT}\n\n${request.context}`,
        user: generationMessage(request),
        schema: ArtifactSchema,
        timeoutMs,
        label: 'generation',
      });
      return { artifact: reply.value, ...reply.usage };
    },
  };
}

export function groqReviewer(options: GroqOptions): Reviewer {
  return {
    model: options.model,
    async review(request, { timeoutMs }) {
      const reply = await callGroqJson(options, {
        system: `${REVIEW_INSTRUCTIONS}\n\n${REVIEW_JSON_FORMAT}\n\n${request.context}`,
        user: reviewMessage(request),
        schema: ReviewVerdictSchema,
        timeoutMs,
        label: 'review',
      });
      return { ...reply.value, ...reply.usage };
    },
  };
}
