// The @slime-cloud/core/claude entry (C7). Needs the optional peer dependency @anthropic-ai/sdk.
import { claudeGenerator, claudeOptimizer, claudeReviewer } from './claude-models.js';

export type { ClaudeOptions, Effort } from './structured-call.js';
export { claudeGenerator, claudeOptimizer, claudeReviewer };

/** claude.generator(...), claude.reviewer(...) and claude.optimizer(...), each with { apiKey, model } (§5). */
export const claude = Object.freeze({ generator: claudeGenerator, reviewer: claudeReviewer, optimizer: claudeOptimizer });
