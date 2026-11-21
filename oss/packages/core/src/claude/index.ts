// The @slime-cloud/core/claude entry (C7). Needs the optional peer dependency @anthropic-ai/sdk.
import { claudeGenerator, claudeReviewer } from './claude-models.js';

export type { ClaudeOptions, Effort } from './structured-call.js';
export { claudeGenerator, claudeReviewer };

/** claude.generator({ apiKey, model }) and claude.reviewer({ apiKey, model }) (§5). */
export const claude = Object.freeze({ generator: claudeGenerator, reviewer: claudeReviewer });
