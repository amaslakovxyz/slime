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
import { ArtifactSchema, ArtifactV2Schema, OptimizedCodeSchema, ReviewVerdictSchema } from './schemas.js';
import { isArtifactV2, type AnyArtifact } from './artifact-v2.js';
import {
  MULTI_SOURCE_ARTIFACT_JSON_FORMAT,
  MULTI_SOURCE_GENERATION_INSTRUCTIONS,
  MULTI_SOURCE_REVIEW_INSTRUCTIONS,
  multiSourceReviewMessage,
} from './prompts-multi-source.js';
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
const MULTI_SOURCE_GENERATION: RolePrompt = { instructions: MULTI_SOURCE_GENERATION_INSTRUCTIONS, jsonFormat: MULTI_SOURCE_ARTIFACT_JSON_FORMAT };
const MULTI_SOURCE_REVIEW: RolePrompt = { instructions: MULTI_SOURCE_REVIEW_INSTRUCTIONS, jsonFormat: REVIEW_JSON_FORMAT };
const PART_SEPARATOR = '\n\n';

/** A provider's public entry: each role built from the same client options. */
export interface ProviderRoles<Options> {
  generator(options: Options): Generator;
  reviewer(options: Options): Reviewer;
  optimizer(options: Options): Optimizer;
}

export function modelRoles(client: ModelClient): ModelRoles {
  return Object.freeze({ generator: generatorFor(client), reviewer: reviewerFor(client), optimizer: optimizerFor(client) });
}

/** The only provider-specific part is the client; prompts, schemas and roles are shared. */
export function providerRoles<Options>(clientFor: (options: Options) => ModelClient): ProviderRoles<Options> {
  return Object.freeze({
    generator: (options: Options) => modelRoles(clientFor(options)).generator,
    reviewer: (options: Options) => modelRoles(clientFor(options)).reviewer,
    optimizer: (options: Options) => modelRoles(clientFor(options)).optimizer,
  });
}

function generatorFor(client: ModelClient): Generator {
  return {
    model: client.model,
    promptHash: promptHash(client.provider, ...instructionParts(client, GENERATION)),
    multiSourcePromptHash: promptHash(client.provider, ...instructionParts(client, MULTI_SOURCE_GENERATION)),
    async generate(request, options) {
      const isMultiSource = request.format === 'v2';
      const reply = await client.call<AnyArtifact>({
        ...callBasics(client, isMultiSource ? MULTI_SOURCE_GENERATION : GENERATION, options),
        context: request.context,
        message: generationMessage(request),
        schema: isMultiSource ? ArtifactV2Schema : ArtifactSchema,
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
      const isMultiSource = isArtifactV2(request.artifact);
      const reply = await client.call({
        ...callBasics(client, isMultiSource ? MULTI_SOURCE_REVIEW : REVIEW, options),
        context: request.context,
        message: isMultiSource ? multiSourceReviewMessage(request) : reviewMessage(request),
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
