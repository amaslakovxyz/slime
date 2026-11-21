// deleting -> (item removed), for one endpoint item.
//
// Every step treats "not found" as done, so a redelivered or retried record
// resumes where the last attempt stopped. Usage items (USAGE#<id>) stay: they
// are billing history. If a step fails, the endpoint becomes failed with the
// message; the admin lets the user delete a failed endpoint again.
import { DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DeleteRoleCommand, DeleteRolePolicyCommand } from '@aws-sdk/client-iam';
import { DeleteFunctionCommand, DeleteFunctionUrlConfigCommand } from '@aws-sdk/client-lambda';
import { DeleteParametersCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { BatchWriteCommand, DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { endpointKey, errorMessage, functionName, logGroupName, secretsPath, tolerate, type Deps, type Endpoint } from './deps.js';

/** BatchWriteItem takes at most 25 requests; DeleteParameters at most 10 names. */
const BATCH_WRITE_MAX = 25;
const DELETE_PARAMETERS_MAX = 10;
const UNPROCESSED_ATTEMPTS = 8;

export async function teardown(ep: Endpoint, deps: Deps): Promise<void> {
  try {
    await removeResources(ep, deps);
  } catch (err) {
    const error = `Delete failed: ${errorMessage(err)}`.slice(0, 300);
    await deps.ddb.send(
      new UpdateCommand({
        TableName: deps.config.controlTable,
        Key: endpointKey(ep),
        UpdateExpression: 'SET #s = :s, #err = :e, updatedAt = :u',
        ExpressionAttributeNames: { '#s': 'status', '#err': 'error' },
        ExpressionAttributeValues: { ':s': 'failed', ':e': error, ':u': new Date().toISOString() },
      }),
    );
    console.log(JSON.stringify({ teardown: 'failed', endpointId: ep.endpointId, error }));
    return;
  }
  console.log(JSON.stringify({ teardown: 'done', endpointId: ep.endpointId }));
}

async function removeResources(ep: Endpoint, deps: Deps): Promise<void> {
  const { config, ddb, iam, lambda, logs, ssm } = deps;
  const id = ep.endpointId;
  const fn = functionName(id);

  await tolerate(lambda.send(new DeleteFunctionUrlConfigCommand({ FunctionName: fn })), 'ResourceNotFoundException');
  await tolerate(lambda.send(new DeleteFunctionCommand({ FunctionName: fn })), 'ResourceNotFoundException');

  await tolerate(iam.send(new DeleteRolePolicyCommand({ RoleName: fn, PolicyName: 'endpoint' })), 'NoSuchEntityException');
  await tolerate(iam.send(new DeleteRoleCommand({ RoleName: fn })), 'NoSuchEntityException');

  await tolerate(logs.send(new DeleteLogGroupCommand({ logGroupName: logGroupName(id) })), 'ResourceNotFoundException');

  const names: string[] = [];
  let NextToken: string | undefined;
  do {
    const res = await ssm.send(new GetParametersByPathCommand({ Path: secretsPath(id), Recursive: true, NextToken }));
    for (const p of res.Parameters ?? []) if (p.Name) names.push(p.Name);
    NextToken = res.NextToken;
  } while (NextToken);
  for (let i = 0; i < names.length; i += DELETE_PARAMETERS_MAX) {
    await ssm.send(new DeleteParametersCommand({ Names: names.slice(i, i + DELETE_PARAMETERS_MAX) }));
  }

  // Collect every Liquid key first: deleting while paging would shift the pages.
  const keys: Array<Record<string, unknown>> = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: config.handlersTable,
        KeyConditionExpression: 'tenantId = :t',
        ExpressionAttributeValues: { ':t': id },
        ProjectionExpression: 'tenantId, artifactKey',
        ExclusiveStartKey,
      }),
    );
    for (const item of res.Items ?? []) keys.push({ tenantId: item.tenantId, artifactKey: item.artifactKey });
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  for (let i = 0; i < keys.length; i += BATCH_WRITE_MAX) {
    let requests = keys.slice(i, i + BATCH_WRITE_MAX).map((Key) => ({ DeleteRequest: { Key } }));
    // DynamoDB may hand back part of a batch under throttling; resend just that.
    for (let attempt = 1; requests.length; attempt++) {
      if (attempt > UNPROCESSED_ATTEMPTS) throw new Error('Liquid handlers stayed unprocessed');
      if (attempt > 1) await deps.sleep(200 * 2 ** attempt);
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [config.handlersTable]: requests } }));
      requests = (res.UnprocessedItems?.[config.handlersTable] ?? []) as typeof requests;
    }
  }

  await ddb.send(new DeleteCommand({ TableName: config.controlTable, Key: endpointKey(ep) }));
}
