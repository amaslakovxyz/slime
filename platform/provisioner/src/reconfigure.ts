// updating -> provisioning -> ready | failed, after the admin changed an
// endpoint's connector secret or provider.
//
// Secrets are loaded from SSM once per instance (cold start), so a new
// SLIME_CONFIG_VERSION is written alongside SLIME_PROVIDER: any configuration
// change retires the warm instances, and new ones read the current secrets.
// Failure handling matches provision: any error after the claim ends as failed.
import { GetFunctionConfigurationCommand, GetFunctionUrlConfigCommand, UpdateFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { endpointKey, errorMessage, errorName, functionName, type Deps, type Endpoint } from './deps.js';
import { checkHealth, recordOutcome, RETRY_DELAY_MS, type Outcome } from './outcome.js';

/** An update is rejected while the previous one is still in progress. */
const UPDATE_ATTEMPTS = 20;

export async function reconfigure(ep: Endpoint, deps: Deps): Promise<void> {
  const { ddb, config } = deps;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: config.controlTable,
        Key: endpointKey(ep),
        UpdateExpression: 'SET #s = :provisioning, updatedAt = :u',
        // Another invocation (or a redelivery) already owns this endpoint.
        ConditionExpression: '#s = :updating',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':provisioning': 'provisioning', ':updating': 'updating', ':u': new Date().toISOString() },
      }),
    );
  } catch (err) {
    if (errorName(err) === 'ConditionalCheckFailedException') return;
    throw err;
  }

  let url: string | undefined;
  let outcome: Outcome;
  try {
    url = await apply(ep, deps);
    outcome = await checkHealth(ep, url, deps);
  } catch (err) {
    outcome = { ok: false, error: errorMessage(err) };
  }

  await recordOutcome(ep, deps, outcome, { url });
  console.log(JSON.stringify({ reconfigure: outcome.ok ? 'ready' : 'failed', endpointId: ep.endpointId, ...(outcome.ok ? {} : { error: outcome.error }) }));
}

/** Merges the new settings into the function's env, waits for the update; returns the Function URL. */
async function apply(ep: Endpoint, deps: Deps): Promise<string> {
  const { lambda } = deps;
  const fn = functionName(ep.endpointId);

  const current = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fn }));
  const update = new UpdateFunctionConfigurationCommand({
    FunctionName: fn,
    Environment: {
      Variables: {
        ...(current.Environment?.Variables ?? {}),
        SLIME_PROVIDER: ep.provider,
        SLIME_CONFIG_VERSION: ep.updatedAt ?? new Date().toISOString(),
      },
    },
  });
  for (let attempt = 1; ; attempt++) {
    try {
      await lambda.send(update);
      break;
    } catch (err) {
      if (errorName(err) !== 'ResourceConflictException' || attempt >= UPDATE_ATTEMPTS) throw err;
      await deps.sleep(RETRY_DELAY_MS);
    }
  }
  await deps.waitUpdated(fn);

  const url = (await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: fn }))).FunctionUrl;
  if (!url) throw new Error(`No Function URL for ${fn}`);
  return url;
}
