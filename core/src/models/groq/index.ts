// The @slime-cloud/core/groq entry (C7). Calls Groq with fetch, so it needs no extra package.
import type { Generator, Optimizer, Reviewer } from '../types.js';
import { modelRoles } from '../roles.js';
import { groqClient, type GroqOptions } from './groq-client.js';

export type { GroqOptions, ReasoningEffort } from './groq-client.js';

export function groqGenerator(options: GroqOptions): Generator {
  return modelRoles(groqClient(options)).generator;
}

export function groqReviewer(options: GroqOptions): Reviewer {
  return modelRoles(groqClient(options)).reviewer;
}

export function groqOptimizer(options: GroqOptions): Optimizer {
  return modelRoles(groqClient(options)).optimizer;
}

/** groq.generator(...), groq.reviewer(...) and groq.optimizer(...), each with { apiKey, model }. */
export const groq = Object.freeze({ generator: groqGenerator, reviewer: groqReviewer, optimizer: groqOptimizer });
