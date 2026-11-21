// Crystal comes first: reviewed, equivalence-tested code that ships with the app (C10).
import type { ParsedRequest } from '../request/parse.js';
import { checkParamTypes } from '../request/params.js';
import { runCrystal } from './crystal/run-crystal.js';
import type { CrystalHandler } from './crystal/types.js';
import { queryMeta } from './meta.js';
import type { EngineParts } from './slime-engine.js';
import type { QueryResult } from './types.js';

export interface CrystalAnswer {
  key: string;
  crystal: CrystalHandler;
  request: ParsedRequest;
  startedAt: number;
}

export async function answerFromCrystal({ config, runner }: EngineParts, { key, crystal, request, startedAt }: CrystalAnswer): Promise<QueryResult> {
  checkParamTypes(crystal.paramTypes, request.input);
  const { connector, limits, mode } = config;
  // The engine's runner: a source-text shape (a Crystal loaded as data) runs in the sandbox with Liquid's limits.
  const execution = await runCrystal({ connector, runner, limits }, crystal, request.input);
  const code = { sql: crystal.sql, shapeJs: crystal.shape ? String(crystal.shape) : null, assumptions: [] };
  const meta = queryMeta({ handlerKey: key, tier: 'crystal', cache: 'hit', review: crystal.review, execution, code, mode, intent: request.intent, totalMs: performance.now() - startedAt });
  return { data: execution.data, meta };
}
