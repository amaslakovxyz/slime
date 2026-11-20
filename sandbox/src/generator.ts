import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from './config.js';
import type { SchemaInfo } from './connectors/types.js';
import { SlimeError } from './errors.js';

export { ArtifactSchema, INSTRUCTIONS, type Artifact } from './prompts.js';
import type { Artifact } from './prompts.js';
import { ArtifactSchema, INSTRUCTIONS } from './prompts.js';


export interface GenerationRequest {
  intent: string;
  inputSig: Record<string, string>;
  output: unknown;
  previous?: { artifact: Artifact; error: string };
}

export interface GenerationResult {
  artifact: Artifact;
  ms: number; // model request time, excluding rate-limit waits
  waitMs: number; // time spent waiting out provider rate limits
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** Any model provider that can turn a request into a handler. */
export interface Generator {
  generate(req: GenerationRequest, timeoutMs: number): Promise<GenerationResult>;
}

export function buildUserMessage(req: GenerationRequest): string {
  const parts = [
    `Intent: ${req.intent}`,
    `Input parameters (name: type): ${JSON.stringify(req.inputSig)}`,
    `Output shape: ${JSON.stringify(req.output)}`,
  ];
  if (req.previous) {
    parts.push(
      '',
      `Your previous handler failed with: ${req.previous.error}`,
      `Previous handler: ${JSON.stringify(req.previous.artifact)}`,
      'Return a corrected handler.',
    );
  }
  return parts.join('\n');
}

export function renderSchema(schema: SchemaInfo): string {
  const lines = [`Database: ${schema.dialect}`];
  for (const t of schema.tables) {
    const pk = t.primaryKey.length ? ` (primary key: ${t.primaryKey.join(', ')})` : '';
    lines.push('', `Table ${t.name}${pk}${t.comment ? ` -- ${t.comment}` : ''}`);
    for (const c of t.columns) {
      lines.push(`  ${c.name} ${c.type}${c.nullable ? ' null' : ''}${c.comment ? ` -- ${c.comment}` : ''}`);
    }
    for (const fk of t.foreignKeys) lines.push(`  ${fk.column} references ${fk.references}`);
  }
  return lines.join('\n');
}

export class ClaudeGenerator implements Generator {
  // Reads ANTHROPIC_API_KEY (or an `ant auth login` profile) from the environment.
  private client = new Anthropic({ maxRetries: 1 });

  constructor(private readonly schemaText: string) {}

  async generate(req: GenerationRequest, timeoutMs: number): Promise<GenerationResult> {
    const started = performance.now();
    let response;
    try {
      response = await this.client.messages.parse(
        {
          model: config.model,
          max_tokens: 4000,
          system: [
            { type: 'text', text: INSTRUCTIONS },
            // Schema is the same for every request: cache the whole system prefix.
            { type: 'text', text: this.schemaText, cache_control: { type: 'ephemeral' } },
          ],
          messages: [{ role: 'user', content: buildUserMessage(req) }],
          output_config: { format: zodOutputFormat(ArtifactSchema), effort: config.effort },
          ...(config.thinking ? {} : { thinking: { type: 'disabled' as const } }),
        },
        { timeout: timeoutMs },
      );
    } catch (err) {
      throw toSlimeError(err);
    }
    const ms = performance.now() - started;

    if (response.stop_reason === 'refusal') {
      throw new SlimeError('GENERATION_FAILED', 'The model declined to generate a handler for this request.');
    }
    if (response.stop_reason === 'max_tokens' || !response.parsed_output) {
      throw new SlimeError('GENERATION_FAILED', 'The model returned an incomplete handler.', true);
    }
    return {
      artifact: response.parsed_output,
      ms,
      waitMs: 0,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    };
  }
}

function toSlimeError(err: unknown): SlimeError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new SlimeError('GENERATION_FAILED', 'Claude API rejected the credentials. Set ANTHROPIC_API_KEY in sandbox/.env.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new SlimeError('GENERATION_RATE_LIMITED', 'Claude API rate limit reached.', true);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new SlimeError('GENERATION_TIMEOUT', 'Code generation took too long.', true);
  }
  if (err instanceof Anthropic.APIError) {
    return new SlimeError('GENERATION_FAILED', `Claude API error ${err.status ?? ''}: ${err.message}`, true);
  }
  return new SlimeError('GENERATION_FAILED', `Code generation failed: ${(err as Error).message ?? String(err)}`);
}
