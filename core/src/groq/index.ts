// The @slime-cloud/core/groq entry (C7). Calls Groq with fetch, so it needs no extra package.
import { groqGenerator, groqOptimizer, groqReviewer } from './groq-models.js';

export type { GroqOptions, ReasoningEffort } from './groq-client.js';
export { groqGenerator, groqOptimizer, groqReviewer };

/** groq.generator(...), groq.reviewer(...) and groq.optimizer(...), each with { apiKey, model }. */
export const groq = Object.freeze({ generator: groqGenerator, reviewer: groqReviewer, optimizer: groqOptimizer });
