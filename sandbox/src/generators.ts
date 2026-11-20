// Picks the generator and reviewer from SLIME_PROVIDER. Loaded only in explore
// mode, so locked mode never imports any model client.
import { config } from './config.js';
import type { SchemaInfo } from './connectors/types.js';
import { CLAUDE_PROMPT_HASH, ClaudeGenerator, renderSchema, type Generator } from './generator.js';
import { ClaudeReviewer, type Reviewer } from './review.js';

export async function createGenerator(
  schema: SchemaInfo,
): Promise<{ generator: Generator; reviewer: Reviewer | null; promptHash: string }> {
  const schemaText = renderSchema(schema);
  if (config.provider === 'groq') {
    const { GroqGenerator, GroqReviewer, GROQ_PROMPT_HASH } = await import('./generator-groq.js');
    return {
      generator: new GroqGenerator(schemaText),
      reviewer: config.review ? new GroqReviewer(schemaText) : null,
      promptHash: GROQ_PROMPT_HASH,
    };
  }
  return {
    generator: new ClaudeGenerator(schemaText),
    reviewer: config.review ? new ClaudeReviewer(schemaText) : null,
    promptHash: CLAUDE_PROMPT_HASH,
  };
}
