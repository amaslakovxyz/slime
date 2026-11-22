// Crystal comes first: reviewed, equivalence-tested code that ships with the app (C10).
import { ARTIFACT_VERSION, sqlOf } from '../../artifact/artifact.js';
import type { ParsedRequest } from '../../request/parse.js';
import { checkParamTypes } from '../../request/params.js';
import { runCrystal } from './run-crystal.js';
import { isStepsCrystal, type CrystalHandler } from '../../handler/crystal.js';
import { queryMeta } from '../meta.js';
import type { EngineParts } from '../slime-engine.js';
import type { QueryResult } from '../types.js';

export interface CrystalAnswer {
  key: string;
  crystal: CrystalHandler;
  request: ParsedRequest;
  startedAt: number;
}

export async function answerFromCrystal({ config, runner, apiSchemas }: EngineParts, { key, crystal, request, startedAt }: CrystalAnswer): Promise<QueryResult> {
  checkParamTypes(crystal.paramTypes, request.input);
  const { connector, limits, sources } = config;
  // The engine's runner: a source-text shape (a Crystal loaded as data) runs in the sandbox with Liquid's limits.
  const execution = await runCrystal({ connector, runner, limits, sources, apiSchemas }, crystal, request.input);
  const code = { sql: sqlOfCrystal(crystal), shapeJs: crystal.shape ? String(crystal.shape) : null, assumptions: [] };
  const meta = queryMeta({ handlerKey: key, tier: 'crystal', cache: 'hit', review: crystal.review, execution, code, intent: request.intent, totalMs: performance.now() - startedAt });
  return { data: execution.data, meta };
}

function sqlOfCrystal(crystal: CrystalHandler): string {
  if (!isStepsCrystal(crystal)) return crystal.sql;
  return sqlOf({ version: ARTIFACT_VERSION, unsatisfiable: null, steps: [...crystal.steps], shapeJs: null, assumptions: [] });
}
