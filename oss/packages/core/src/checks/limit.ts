import { SlimeError } from '../errors.js';
import type { InputValues } from '../request/parse.js';

/** R6: a top-level list may not have more rows than input.limit; checked without a model. */
export function assertWithinLimit(data: unknown, input: InputValues): void {
  const { limit } = input;
  if (typeof limit !== 'number' || !Array.isArray(data) || data.length <= limit) return;
  throw new SlimeError('INVALID_HANDLER', `The handler returned ${data.length} rows, but input.limit is ${limit}.`);
}
