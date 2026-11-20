import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config } from './config.js';
import type { SchemaInfo } from './connectors/types.js';
import { SlimeError } from './errors.js';
import { sha256 } from './fingerprint.js';

export const ArtifactSchema = z.object({
  unsatisfiable: z.string().nullable(),
  sql: z.string(),
  params: z.array(z.string()),
  shapeJs: z.string().nullable(),
  assumptions: z.array(z.string()),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// Kept byte-stable: it is the cached prompt prefix, and its hash is part of every
// handler's cache key (editing it invalidates old handlers automatically).
export const INSTRUCTIONS = `You write read-only data handlers for Slime, a backend that answers frontend data requests.

You get a database schema, a request intent, the NAMES and TYPES of the input parameters (never their values), and the JSON output shape the caller wants. Return:
- unsatisfiable: null, or one sentence saying why the schema cannot answer the request (missing tables/columns, or the request asks to change data). If set, the other fields are ignored: use "" and [].
- sql: ONE PostgreSQL SELECT statement (a WITH ... SELECT is fine) that fetches what the output needs. No trailing semicolon.
- params: the input parameter name for each placeholder, in order: params[0] is $1, params[1] is $2.
- shapeJs: null when every SQL row already is one list item of the requested output (the output is a list of flat objects and the SQL column aliases are exactly the requested keys). Otherwise, JavaScript source that defines: function shape(rows, input) { ... return output; }
- assumptions: short notes on interpretations you made (for example how a vague term like "churn risk" was computed). [] if none.

SQL rules:
- Read only. Never write INSERT, UPDATE, DELETE, DDL, set_config, pg_sleep, or query system catalogs.
- Use input values only through $n placeholders with an explicit cast ($1::int, $2::timestamptz, $3::text). Never copy a value from the intent into the SQL; if the intent mentions a value that is not an input parameter, use a sensible default only when the intent clearly implies one.
- Do filtering, joins, aggregation, sorting and limits in SQL. ORDER BY whenever the order matters.
- Use only tables and columns listed in the schema.
- Return numbers as numbers: cast counts with ::int, money/averages with ::float8 or ROUND(x::numeric, 2)::float8.
- Return dates and timestamps that appear in the output as text, e.g. to_char(ts, 'YYYY-MM-DD').
- Alias columns with the exact output key names when shapeJs is null. Postgres lowercases unquoted names, so double-quote any alias with capitals: AS "revenueCents", never AS revenueCents.

shapeJs rules:
- Plain synchronous JavaScript (ES2020). Only standard built-ins (Array, Object, Math, String, Number, JSON, Date). No require, import, fetch, timers, or async.
- Use it for nesting, grouping into sub-lists, renaming and formatting. Keep it short.
- The returned value must match the output shape exactly: same keys, no extra keys.

Output shape notation: leaves are type names ("string", "number", "integer", "boolean", optionally "|null"); an array with one element means a list of that element; an object means exactly those keys.`;

export const CLAUDE_PROMPT_HASH = sha256(`claude\n${INSTRUCTIONS}`).slice(0, 16);

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
