// The tail provision and reconfigure share: probe the endpoint's /healthz, then
// write the final status (ready or failed) to its control item.
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { endpointKey, secretsPath, type Deps, type Endpoint } from './deps.js';

export type Outcome = { ok: true } | { ok: false; error: string };

export const HEALTH_ATTEMPTS = 5;
export const RETRY_DELAY_MS = 3000;

/**
 * GET /healthz with the endpoint's key. The runtime's healthz runs the DB
 * safety check, so an unsafe or unreachable customer database ends as failed.
 * 403 and 5xx are retried: the URL permission and a cold start can lag.
 */
export async function checkHealth(ep: Endpoint, url: string, deps: Deps): Promise<Outcome> {
  const res = await deps.ssm.send(new GetParameterCommand({ Name: `${secretsPath(ep.endpointId)}SLIME_API_KEY`, WithDecryption: true }));
  const token = res.Parameter?.Value;
  if (!token) throw new Error('SLIME_API_KEY parameter is empty');

  for (let attempt = 1; ; attempt++) {
    const health = await deps.fetch(`${url}healthz`, { headers: { 'x-api-key': token }, signal: AbortSignal.timeout(25000) });
    if (health.status === 200) return { ok: true };
    const body = await health.text();
    const retryable = health.status === 403 || health.status >= 500;
    if (!retryable || attempt >= HEALTH_ATTEMPTS) return { ok: false, error: (body || `healthz answered ${health.status}`).slice(0, 300) };
    await deps.sleep(RETRY_DELAY_MS);
  }
}

/**
 * ready (REMOVE error) or failed (error), plus `url` when known and `layerArn`
 * when given (provision records the layer the function was created on).
 * Not caught: a lost status write must surface as a stream retry.
 */
export async function recordOutcome(ep: Endpoint, deps: Deps, outcome: Outcome, set: { url?: string; layerArn?: string }): Promise<void> {
  const names: Record<string, string> = { '#s': 'status', '#err': 'error' };
  const values: Record<string, unknown> = { ':s': outcome.ok ? 'ready' : 'failed', ':u': new Date().toISOString() };
  const assignments = ['#s = :s'];
  if (set.url) {
    names['#url'] = 'url';
    values[':url'] = set.url;
    assignments.push('#url = :url');
  }
  if (outcome.ok && set.layerArn) {
    values[':layer'] = set.layerArn;
    assignments.push('layerArn = :layer');
  }
  if (!outcome.ok) {
    values[':e'] = outcome.error;
    assignments.push('#err = :e');
  }
  assignments.push('updatedAt = :u');

  await deps.ddb.send(
    new UpdateCommand({
      TableName: deps.config.controlTable,
      Key: endpointKey(ep),
      UpdateExpression: `SET ${assignments.join(', ')}${outcome.ok ? ' REMOVE #err' : ''}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}
