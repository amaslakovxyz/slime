// The @slime-cloud/core/claude entry (C7). Needs the optional peer dependency @anthropic-ai/sdk.
import { providerRoles } from '../roles.js';
import { claudeClient } from './claude-client.js';

export type { ClaudeOptions, Effort } from './claude-client.js';

/** claude.generator(...), claude.reviewer(...) and claude.optimizer(...), each with { apiKey, model } (§5). */
export const claude = providerRoles(claudeClient);
