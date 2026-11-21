// Cloud mode (SLIME_RUNTIME_URL set): no runner watches slime-control, so the
// admin's server actions finish each transition of Contract 3 in the same request.
//   create:      item `provisioning` (+ url) -> GET <url>healthz -> ready | failed
//   reconfigure: item `updating` -> POST <url>v0/reload -> healthz -> ready | failed
//   check:       the same, for an item an interrupted action left behind
//   remove:      item `deleting` -> shared teardown -> gone | failed (deletable again)
// The shared runtime already serves every id whose SSM path exists, so there is
// nothing to deploy: the health check is the whole provisioning step.
import { setTimeout as sleep } from 'node:timers/promises';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb';
import { endpointKey, requestDelete, requireEndpoint, type Endpoint, type Status } from './endpoints';
import { env } from './env';
import { CodedError } from './errors';
import { secretStore } from './secrets';
import { removeEndpoint, type CrystalObjects } from './teardown';

/** Errors shown on the endpoint stay short; the runtime's cause comes first. */
const ERROR_MAX = 300;

/** How long healthz is retried while the runtime answers 5xx or not at all. */
export interface CheckTiming {
  windowMs: number;
  retryMs: number;
}

/** 20 s keeps create under the 30 s promised to the user and well under the 60 s Lambda limit. */
const DEFAULT_TIMING: CheckTiming = { windowMs: 20_000, retryMs: 1000 };

type Outcome = { ok: true } | { ok: false; error: string };

/** The runtime's `{error: {message}}` when it sent one, else the raw body. */
function reasonFrom(status: number, body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const { error } = parsed;
      if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
    }
  } catch {
    // not JSON
  }
  return body.trim() || `healthz answered ${status}`;
}

/**
 * GET <url>healthz with the endpoint's key. The runtime builds the endpoint's engine for it,
 * so an unreachable or unsafe database answers 503 with the cause. 5xx and network errors are
 * retried every `retryMs` until `windowMs` passes (a cold start, SSM not visible yet); any
 * other status is final.
 */
async function healthz(ep: Endpoint, timing: CheckTiming, { fresh = false } = {}): Promise<Outcome> {
  const token = await secretStore().get(ep.endpointId, 'SLIME_API_KEY');
  if (!ep.url || !token) return { ok: false, error: 'Endpoint URL or key is missing' };
  const deadline = Date.now() + timing.windowMs;
  // The runtime's own reason (e.g. the database error) beats ours: a last try cut short by the
  // window must not replace "Database unreachable" with "did not answer".
  let lastAnswer: string | undefined;
  for (;;) {
    let error: string;
    try {
      // fresh: the runtime re-reads the settings in this same call, so another warm instance's cache cannot answer.
      const res = await fetch(new URL(fresh ? 'healthz?fresh=1' : 'healthz', ep.url), {
        headers: { 'x-api-key': token },
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.max(deadline - Date.now(), timing.retryMs)),
      });
      if (res.ok) return { ok: true };
      error = lastAnswer = reasonFrom(res.status, await res.text());
      if (res.status < 500) return { ok: false, error };
    } catch (err) {
      error = lastAnswer ?? `Endpoint runtime did not answer: ${(err as Error).message}`;
    }
    if (Date.now() + timing.retryMs >= deadline) return { ok: false, error };
    await sleep(timing.retryMs);
  }
}

/**
 * ready (error removed) or failed (+ error), only from the state this action acted on: a
 * concurrent delete or another tab's action wins, and this outcome is dropped.
 */
async function settle(owner: string, endpointId: string, from: Status, outcome: Outcome): Promise<void> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: env().controlTable,
        Key: endpointKey(owner, endpointId),
        UpdateExpression: outcome.ok ? 'SET #s = :s, updatedAt = :now REMOVE #e' : 'SET #s = :s, #e = :e, updatedAt = :now',
        ConditionExpression: '#s = :from',
        ExpressionAttributeNames: { '#s': 'status', '#e': 'error' },
        ExpressionAttributeValues: {
          ':s': outcome.ok ? 'ready' : 'failed',
          ':from': from,
          ':now': new Date().toISOString(),
          ...(outcome.ok ? {} : { ':e': outcome.error.slice(0, ERROR_MAX) }),
        },
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
}

/** After createEndpoint wrote `provisioning`: health-check the new path and settle it. */
export async function provision(owner: string, endpointId: string, timing = DEFAULT_TIMING): Promise<void> {
  const ep = await requireEndpoint(owner, endpointId);
  if (ep.status !== 'provisioning') return;
  await settle(owner, endpointId, 'provisioning', await healthz(ep, timing));
}

/**
 * After a connector or provider change wrote `updating`: healthz with `fresh=1` makes the
 * instance that answers re-read the settings before it checks them. Other warm instances
 * re-read SSM within their TTL (30 s).
 */
export async function reconfigure(owner: string, endpointId: string, timing = DEFAULT_TIMING): Promise<void> {
  const ep = await requireEndpoint(owner, endpointId);
  if (ep.status !== 'updating') return;
  await settle(owner, endpointId, 'updating', await healthz(ep, timing, { fresh: true }));
}

/** Retry check: finishes what an interrupted create or reconfigure left in `provisioning`/`updating`. */
export async function check(owner: string, endpointId: string, timing = DEFAULT_TIMING): Promise<void> {
  const ep = await requireEndpoint(owner, endpointId);
  if (ep.status === 'provisioning') await provision(owner, endpointId, timing);
  else if (ep.status === 'updating') await reconfigure(owner, endpointId, timing);
  else throw new CodedError('NOT_UPDATABLE', `Only a provisioning or updating endpoint can be re-checked (now ${ep.status})`);
}

/**
 * Delete from any state but `deleting`, then tear down in the request. A failed step leaves the
 * endpoint `failed` with the reason, so Delete can run again.
 */
export async function remove(owner: string, endpointId: string, deps: { s3?: CrystalObjects } = {}): Promise<void> {
  const { crystalBucket, handlersTable } = env();
  if (!crystalBucket) throw new Error('SLIME_CRYSTAL_BUCKET is not set');
  await requestDelete(owner, endpointId);
  try {
    await removeEndpoint({
      endpointId,
      owner,
      handlersTable,
      crystals: { kind: 's3', bucket: crystalBucket, client: deps.s3 ?? new S3Client({}) },
      secrets: secretStore(),
    });
  } catch (err) {
    const error = `Delete failed: ${(err as Error).message}`.slice(0, ERROR_MAX);
    await settle(owner, endpointId, 'deleting', { ok: false, error });
    throw new CodedError('DELETE_FAILED', error);
  }
}
