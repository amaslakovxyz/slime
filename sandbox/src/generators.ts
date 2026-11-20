// Picks the generator and reviewer from SLIME_PROVIDER. Loaded only in explore
// mode, so locked mode never imports any model client.
import { config } from './config.js';
import type { SchemaInfo } from './connectors/types.js';
import { ClaudeGenerator, renderSchema, type Generator } from './generator.js';
import type { Reviewer } from './review.js';

export async function createGenerator(schema: SchemaInfo): Promise<{ generator: Generator; reviewer: Reviewer | null }> {
  if (config.provider === 'offline') {
    const { OfflineGenerator, OfflineReviewer } = await import('./generator-offline.js');
    return {
      generator: OfflineGenerator.fromFile(config.offlineHandlersFile),
      reviewer: config.review ? new OfflineReviewer() : null,
    };
  }
  const schemaText = renderSchema(schema);
  if (config.provider === 'groq') {
    const { GroqGenerator, GroqReviewer } = await import('./generator-groq.js');
    return { generator: new GroqGenerator(schemaText), reviewer: config.review ? new GroqReviewer(schemaText) : null };
  }
  const { ClaudeReviewer } = await import('./review.js');
  return { generator: new ClaudeGenerator(schemaText), reviewer: config.review ? new ClaudeReviewer(schemaText) : null };
}
