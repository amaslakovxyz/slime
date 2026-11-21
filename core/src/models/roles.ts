import type { ModelCall, ModelClient } from './model-client.js';
import {
  ARTIFACT_JSON_FORMAT,
  GENERATION_INSTRUCTIONS,
  OPTIMIZE_INSTRUCTIONS,
  OPTIMIZED_JSON_FORMAT,
  REVIEW_INSTRUCTIONS,
  REVIEW_JSON_FORMAT,
  generationMessage,
  optimizeMessage,
  promptHash,
  reviewMessage,
} from './prompts.js';
import { ArtifactSchema, OptimizedCodeSchema, ReviewVerdictSchema } from './schemas.js';
import type { Generator, ModelCallOptions, Optimizer, Reviewer } from './types.js';

export interface ModelRoles {
  generator: Generator;
  reviewer: Reviewer;
  /** Runs offline in the crystallize job, so a stronger model is usually worth it. */
  optimizer: Optimizer;
}

interface RolePrompt {
  instructions: string;
  jsonFormat: string;
}

const GENERATION: RolePrompt = { instructions: GENERATION_INSTRUCTIONS, jsonFormat: ARTIFACT_JSON_FORMAT };
const REVIEW: RolePrompt = { instructions: REVIEW_INSTRUCTIONS, jsonFormat: REVIEW_JSON_FORMAT };
const OPTIMIZE: RolePrompt = { instructions: OPTIMIZE_INSTRUCTIONS, jsonFormat: OPTIMIZED_JSON_FORMAT };
const PART_SEPARATOR = '\n\n';

export function modelRoles(client: ModelClient): ModelRoles {
  return Object.freeze({ generator: generatorFor(client), reviewer: reviewerFor(client), optimizer: optimizerFor(client) });
}

function generatorFor(client: ModelClient): Generator {
  return {
    model: client.model,
    promptHash: promptHash(client.provider, ...instructionParts(client, GENERATION)),
    async generate(request, options) {
      const reply = await client.call({
        ...callBasics(client, GENERATION, options),
        context: request.context,
        message: generationMessage(request),
        schema: ArtifactSchema,
        label: 'generation',
      });
      return { artifact: reply.value, ...reply.usage };
    },
  };
}

function reviewerFor(client: ModelClient): Reviewer {
  return {
    model: client.model,
    async review(request, options) {
      const reply = await client.call({
        ...callBasics(client, REVIEW, options),
        context: request.context,
        message: reviewMessage(request),
        schema: ReviewVerdictSchema,
        label: 'review',
      });
      return { ...reply.value, ...reply.usage };
    },
  };
}

// It sees only code, never the intent or the dictionary.
function optimizerFor(client: ModelClient): Optimizer {
  return {
    model: client.model,
    async optimize(request, options) {
      const reply = await client.call({
        ...callBasics(client, OPTIMIZE, options),
        message: optimizeMessage(request),
        schema: OptimizedCodeSchema,
        label: 'crystal optimize',
      });
      return { code: reply.value, ...reply.usage };
    },
  };
}

type CallBasics = Pick<ModelCall<unknown>, 'instructions' | 'timeoutMs' | 'signal'>;

function callBasics(client: ModelClient, prompt: RolePrompt, { timeoutMs, signal }: ModelCallOptions): CallBasics {
  return { instructions: instructionParts(client, prompt).join(PART_SEPARATOR), timeoutMs, ...(signal ? { signal } : {}) };
}

// Hashed part by part: joining first would change every saved handler's promptHash.
function instructionParts(client: ModelClient, prompt: RolePrompt): string[] {
  return client.outputMode === 'prompt' ? [prompt.instructions, prompt.jsonFormat] : [prompt.instructions];
}
