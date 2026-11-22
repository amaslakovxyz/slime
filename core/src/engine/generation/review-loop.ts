import type { SlimeEvent } from '../../config/events.js';
import type { ModelUsage, ReviewRequest, Reviewer } from '../../models/types.js';
import { generatedEvent } from '../events.js';
import { paramTypesForModel } from '../../request/params.js';
import { generateHandler, type GenerationDeps } from './generate.js';
import type { GenerationLimits } from './limits.js';
import type { HandlerRecord } from '../../handler/record.js';

export interface ReviewDeps {
  reviewer: Reviewer;
  generation: GenerationDeps;
  limits: GenerationLimits;
  maxReviews: number;
  reviewTimeoutMs: number;
  emit: (event: SlimeEvent) => void;
}

export type ReviewOutcome = 'approved' | 'rejected';

/** Reviews the handler; after a rejection, revises it with the reviewer's notes, up to maxReviews reviews (M4 rule). */
export async function reviewUntilSettled(deps: ReviewDeps, record: HandlerRecord): Promise<ReviewOutcome> {
  for (let reviewCount = 1; ; reviewCount++) {
    const { verdict, problems } = await deps.reviewer.review(reviewRequest(deps, record), { timeoutMs: deps.reviewTimeoutMs });
    const isApproved = verdict === 'approve';
    deps.emit({ type: 'reviewed', handlerKey: record.key, verdict: isApproved ? 'approved' : 'rejected', notes: problems.join(' ') });
    if (isApproved) return 'approved';
    if (reviewCount >= deps.maxReviews || !(await revise(deps, record, problems))) return 'rejected';
  }
}

function reviewRequest({ generation }: ReviewDeps, { intent, paramTypes, output, artifact }: HandlerRecord): ReviewRequest {
  return { context: generation.dictionaryText, intent, params: paramTypesForModel(paramTypes), output, artifact };
}

/** The revision replaces the code only after it passed the same checks on a recorded input; runs start over. */
async function revise(deps: ReviewDeps, record: HandlerRecord, problems: string[]): Promise<boolean> {
  const sampleInput = record.fixtures[0] ?? {};
  const previous = { artifact: record.artifact, error: `A reviewer rejected this handler: ${problems.join(' ')}` };
  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await deps.limits.acquire();
    const request = { intent: record.intent, input: sampleInput, output: record.output };
    const { record: revised, usage } = await generateHandler(deps.generation, { key: record.key, request, previous });
    applyRevision(record, revised, usage, deps);
    return true;
  } catch {
    return false;
  } finally {
    releaseSlot?.();
  }
}

function applyRevision(record: HandlerRecord, revised: HandlerRecord, usage: ModelUsage, { emit }: ReviewDeps): void {
  record.artifact = revised.artifact;
  record.runs = 1;
  record.fixtures = revised.fixtures;
  emit(generatedEvent(record, usage));
}
