// The @slime-cloud/core/groq entry (C7). Calls Groq with fetch, so it needs no extra package.
import { providerRoles } from '../roles.js';
import { groqClient } from './groq-client.js';

export type { GroqOptions, ReasoningEffort } from './groq-client.js';

/** groq.generator(...), groq.reviewer(...) and groq.optimizer(...), each with { apiKey, model }. */
export const groq = providerRoles(groqClient);
