// Crystal comes first: reviewed, equivalence-tested code that ships with the app (C10).
import { ARTIFACT_VERSION, sqlOf } from '../../artifact/artifact.js';
import type { ParsedRequest } from '../../request/parse.js';
import { checkParamTypes } from '../../request/params.js';
import { runCrystal } from './run-crystal.js';
import { isStepsCrystal, type CrystalHandler } from '../../handler/crystal.js';
import { queryMeta } from '../meta.js';
import type { EngineParts } from '../slime-engine.js';
import type { QueryResult } from '../types.js';
import { Trace, traceReview } from '../trace.js';

export interface CrystalAnswer {
  key: string;
  crystal: CrystalHandler;
  request: ParsedRequest;
  startedAt: number;
  trace: Trace;
}

const CRYSTAL_KEY_PREFIX = 12;

export async function answerFromCrystal({ config, runner, apiSchemas }: EngineParts, { key, crystal, request, startedAt, trace }: CrystalAnswer): Promise<QueryResult> {
  trace.add('route', 'pass', { note: `Crystal ${key.slice(0, CRYSTAL_KEY_PREFIX)}` });
  trace.add('limits', 'skip', { note: 'no model call' });
  trace.add('generate', 'skip', { note: 'frozen code' });
  trace.add('lint', 'skip', { note: 'checked before freezing' });
  trace.add('cost', 'skip', { note: 'checked before freezing' });
  checkParamTypes(crystal.paramTypes, request.input);
  const { connector, limits, sources } = config;
  // The engine's runner: a source-text shape (a Crystal loaded as data) runs in the sandbox with Liquid's limits.
  let execution;
  try {
    execution = await runCrystal({ connector, runner, limits, sources, apiSchemas }, crystal, request.input);
  } catch (error) {
    trace.fail(error);
    throw error;
  }
  trace.addExecution(execution);
  trace.add('cache', 'skip', { note: 'Crystal: nothing to promote' });
  traceReview(trace, crystal.review, false, 0);
  const code = { sql: sqlOfCrystal(crystal), shapeJs: crystal.shape ? String(crystal.shape) : null, assumptions: [] };
  const meta = queryMeta({ handlerKey: key, tier: 'crystal', cache: 'hit', review: crystal.review, execution, code, intent: request.intent, totalMs: performance.now() - startedAt, trace: trace.spans });
  return { data: execution.data, meta };
}

function sqlOfCrystal(crystal: CrystalHandler): string {
  if (!isStepsCrystal(crystal)) return crystal.sql;
  return sqlOf({ version: ARTIFACT_VERSION, unsatisfiable: null, steps: [...crystal.steps], shapeJs: null, assumptions: [] });
}
