// For 'prompt' output mode: the model was asked for JSON, so check it is JSON
// with the right fields before anything runs. Both failures are retryable:
// sampling again usually fixes them.
import type { z } from 'zod';
import { SlimeError } from '../shared/errors.js';

export function parseJsonReply<T>(text: string, schema: z.ZodType<T>, label: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SlimeError('GENERATION_FAILED', `${label}: the model did not return valid JSON.`, { retryable: true });
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues.map(({ path }) => path.join('.') || '(root)').join(', ');
  throw new SlimeError('GENERATION_FAILED', `${label}: the model's JSON has wrong or missing fields: ${fields}`, { retryable: true });
}
