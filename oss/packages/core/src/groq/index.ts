// The @slime-cloud/core/groq entry (C7). Calls Groq with fetch, so it needs no extra package.
import { groqGenerator, groqReviewer } from './groq-models.js';

export type { GroqOptions, ReasoningEffort } from './groq-client.js';
export { groqGenerator, groqReviewer };

/** groq.generator({ apiKey, model }) and groq.reviewer({ apiKey, model }). */
export const groq = Object.freeze({ generator: groqGenerator, reviewer: groqReviewer });
