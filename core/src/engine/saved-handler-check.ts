// A saved v2 handler is checked against today's sources before it is served: a
// removed source or a renamed Notion property would otherwise fail on every
// request, or silently return wrong data (MS14).
import { isArtifactV2 } from '../models/artifact-v2.js';
import { SlimeError } from '../shared/errors.js';
import type { ApiSchema } from '../sources/types.js';
import { lintSteps } from './checks/steps.js';
import type { HandlerRecord } from './types.js';

export interface SavedHandlerContext {
  sqlSourceName: string;
  apiSchemas: Readonly<Record<string, ApiSchema>>;
  maxSteps: number;
}

/** Why a saved handler can't be served with today's sources, or undefined when it can. */
export function savedHandlerProblem(record: HandlerRecord, context: SavedHandlerContext): string | undefined {
  if (!isArtifactV2(record.artifact)) return undefined;
  // paramTypes holds every input name the handler was made for, null-typed ones included.
  const input = Object.fromEntries(Object.keys(record.paramTypes).map((name) => [name, null]));
  try {
    lintSteps(record.artifact, { ...context, input });
    return undefined;
  } catch (error) {
    if (error instanceof SlimeError) return error.message;
    throw error;
  }
}
