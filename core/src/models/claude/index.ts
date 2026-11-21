// The @slime-cloud/core/claude entry (C7). Needs the optional peer dependency @anthropic-ai/sdk.
import type { Generator, Optimizer, Reviewer } from '../types.js';
import { modelRoles } from '../roles.js';
import { claudeClient, type ClaudeOptions } from './claude-client.js';

export type { ClaudeOptions, Effort } from './claude-client.js';

export function claudeGenerator(options: ClaudeOptions): Generator {
  return modelRoles(claudeClient(options)).generator;
}

export function claudeReviewer(options: ClaudeOptions): Reviewer {
  return modelRoles(claudeClient(options)).reviewer;
}

export function claudeOptimizer(options: ClaudeOptions): Optimizer {
  return modelRoles(claudeClient(options)).optimizer;
}

/** claude.generator(...), claude.reviewer(...) and claude.optimizer(...), each with { apiKey, model } (§5). */
export const claude = Object.freeze({ generator: claudeGenerator, reviewer: claudeReviewer, optimizer: claudeOptimizer });
