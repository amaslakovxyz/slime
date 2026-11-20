// Picks the generator from SLIME_PROVIDER. Loaded only in explore mode, so locked
// mode never imports any model client.
import { config } from './config.js';
import type { SchemaInfo } from './connectors/types.js';
import { CLAUDE_PROMPT_HASH, ClaudeGenerator, renderSchema, type Generator } from './generator.js';

export async function createGenerator(schema: SchemaInfo): Promise<{ generator: Generator; promptHash: string }> {
  const schemaText = renderSchema(schema);
  if (config.provider === 'groq') {
    const { GroqGenerator, GROQ_PROMPT_HASH } = await import('./generator-groq.js');
    return { generator: new GroqGenerator(schemaText), promptHash: GROQ_PROMPT_HASH };
  }
  return { generator: new ClaudeGenerator(schemaText), promptHash: CLAUDE_PROMPT_HASH };
}
