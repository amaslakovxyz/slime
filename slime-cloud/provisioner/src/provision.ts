// pending -> provisioning -> ready | failed, for one endpoint item.
//
// Stream records can be redelivered (maximum_retry_attempts), so every create
// treats "already exists" as success. Any failure after the claim ends as
// status=failed with the message, and the handler returns normally: a poisoned
// record must not block the shard. Only a failed final status write is rethrown.
import { CreateLogGroupCommand, PutRetentionPolicyCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CreateRoleCommand, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import { AddPermissionCommand, CreateFunctionCommand, CreateFunctionUrlConfigCommand, GetFunctionUrlConfigCommand } from '@aws-sdk/client-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  endpointKey,
  errorMessage,
  errorName,
  functionName,
  logGroupName,
  secretsPath,
  tolerate,
  type Deps,
  type Endpoint,
} from './deps.js';
import { checkHealth, recordOutcome, RETRY_DELAY_MS, type Outcome } from './outcome.js';

const LAMBDA_TRUST = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
});

/** A new role is not assumable by Lambda for a few seconds (IAM propagation). */
const CREATE_FUNCTION_ATTEMPTS = 20;

/**
 * Every attribute the runtime's usage flush writes on USAGE#<id> day items
 * (slime-cloud/runtime/src/usage.ts), plus the key. The endpoint role may
 * UpdateItem nothing else on the control table.
 */
export const USAGE_ATTRIBUTES = [
  'pk',
  'sk',
  'requests',
  'generations',
  'gasRequests',
  'liquidRequests',
  'crystalRequests',
  'gasMs',
  'liquidMs',
  'crystalMs',
  'tokens',
  'gasHandlers',
  'liquidHandlers',
  'crystalHandlers',
  'updatedAt',
] as const;

export async function provision(ep: Endpoint, deps: Deps): Promise<void> {
  const { ddb, config } = deps;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: config.controlTable,
        Key: endpointKey(ep),
        UpdateExpression: 'SET #s = :provisioning, updatedAt = :u',
        // Another invocation (or a redelivery) already owns this endpoint.
        ConditionExpression: '#s = :pending',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':provisioning': 'provisioning', ':pending': 'pending', ':u': new Date().toISOString() },
      }),
    );
  } catch (err) {
    if (errorName(err) === 'ConditionalCheckFailedException') return;
    throw err;
  }

  let url: string | undefined;
  let outcome: Outcome;
  try {
    url = await deploy(ep, deps);
    outcome = await checkHealth(ep, url, deps);
  } catch (err) {
    outcome = { ok: false, error: errorMessage(err) };
  }

  await recordOutcome(ep, deps, outcome, { url, layerArn: config.gasLayerArn });
  console.log(JSON.stringify({ provision: outcome.ok ? 'ready' : 'failed', endpointId: ep.endpointId, ...(outcome.ok ? {} : { error: outcome.error }) }));
}

/** Log group, role, function and public Function URL; returns the URL. */
async function deploy(ep: Endpoint, deps: Deps): Promise<string> {
  const { config, iam, lambda, logs } = deps;
  const id = ep.endpointId;
  const fn = functionName(id);
  const logGroup = logGroupName(id);
  const { partition, region, account } = config;
  const tableArn = (name: string) => `arn:${partition}:dynamodb:${region}:${account}:table/${name}`;
  const parameterArns = (path: string) => {
    const base = `arn:${partition}:ssm:${region}:${account}:parameter${path.replace(/\/+$/, '')}`;
    return [base, `${base}/*`];
  };

  await tolerate(logs.send(new CreateLogGroupCommand({ logGroupName: logGroup, tags: { Project: 'slime', Endpoint: id } })), 'ResourceAlreadyExistsException');
  await logs.send(new PutRetentionPolicyCommand({ logGroupName: logGroup, retentionInDays: config.logRetentionDays }));

  const tags = [
    { Key: 'Project', Value: 'slime' },
    { Key: 'Endpoint', Value: id },
  ];
  await tolerate(
    iam.send(new CreateRoleCommand({ RoleName: fn, AssumeRolePolicyDocument: LAMBDA_TRUST, PermissionsBoundary: config.boundaryArn, Tags: tags })),
    'EntityAlreadyExistsException',
  );
  // dynamodb:LeadingKeys pins the role to its own partitions: its Liquid
  // handlers and its usage counter, never another endpoint's.
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'Logs',
        Effect: 'Allow',
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: `arn:${partition}:logs:${region}:${account}:log-group:${logGroup}:*`,
      },
      {
        Sid: 'Liquid',
        Effect: 'Allow',
        Action: ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
        Resource: tableArn(config.handlersTable),
        Condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [id] } },
      },
      {
        Sid: 'Usage',
        Effect: 'Allow',
        Action: ['dynamodb:UpdateItem'],
        Resource: tableArn(config.controlTable),
        // Only the counter attributes: the role cannot shape an item that looks
        // like an endpoint record (defence in depth with the stream filter).
        Condition: {
          'ForAllValues:StringEquals': {
            'dynamodb:LeadingKeys': [`USAGE#${id}`],
            'dynamodb:Attributes': [...USAGE_ATTRIBUTES],
          },
        },
      },
      {
        Sid: 'Settings',
        Effect: 'Allow',
        Action: ['ssm:GetParametersByPath'],
        Resource: [...parameterArns(config.sharedSsmPrefix), ...parameterArns(secretsPath(id))],
      },
      { Sid: 'Tracing', Effect: 'Allow', Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'], Resource: '*' },
    ],
  };
  await iam.send(new PutRolePolicyCommand({ RoleName: fn, PolicyName: 'endpoint', PolicyDocument: JSON.stringify(policy) }));

  const createFunction = new CreateFunctionCommand({
    FunctionName: fn,
    Runtime: 'nodejs22.x',
    Architectures: ['arm64'],
    Handler: 'index.handler',
    Role: `arn:${partition}:iam::${account}:role/${fn}`,
    Code: { ZipFile: Buffer.from(config.shimZipB64, 'base64') },
    Layers: [config.gasLayerArn],
    Timeout: 30,
    MemorySize: 1024,
    TracingConfig: { Mode: 'Active' },
    LoggingConfig: { LogFormat: 'JSON', LogGroup: logGroup },
    Environment: {
      Variables: {
        // Shared provider keys first, then the endpoint's own secrets (later wins).
        SLIME_SSM_PREFIX: `${config.sharedSsmPrefix},${secretsPath(id)}`,
        SLIME_HANDLERS_TABLE: config.handlersTable,
        SLIME_TENANT_ID: id,
        SLIME_USAGE_TABLE: config.controlTable,
        SLIME_PROVIDER: ep.provider,
        // The engine lives in the layer, not in cwd (/var/task holds only the shim).
        SLIME_CRYSTAL_DIR: '/opt/slime/crystal',
        SLIME_OFFLINE_FILE: '/opt/slime/offline/handlers.json',
      },
    },
    Tags: { Project: 'slime', Endpoint: id },
  });
  for (let attempt = 1; ; attempt++) {
    try {
      await tolerate(lambda.send(createFunction), 'ResourceConflictException');
      break;
    } catch (err) {
      const propagating = errorName(err) === 'InvalidParameterValueException' && errorMessage(err).includes('cannot be assumed');
      if (!propagating || attempt >= CREATE_FUNCTION_ATTEMPTS) throw err;
      await deps.sleep(RETRY_DELAY_MS);
    }
  }
  await deps.waitActive(fn);

  let url: string | undefined;
  try {
    url = (await lambda.send(new CreateFunctionUrlConfigCommand({ FunctionName: fn, AuthType: 'NONE' }))).FunctionUrl;
  } catch (err) {
    if (errorName(err) !== 'ResourceConflictException') throw err;
    url = (await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: fn }))).FunctionUrl;
  }
  if (!url) throw new Error(`No Function URL for ${fn}`);
  // Both statements, as for slime-runtime (infra/aws/platform/runtime.tf):
  // new public Function URLs need InvokeFunctionUrl and InvokeFunction.
  await tolerate(
    lambda.send(
      new AddPermissionCommand({
        FunctionName: fn,
        StatementId: 'PublicFunctionUrl',
        Action: 'lambda:InvokeFunctionUrl',
        Principal: '*',
        FunctionUrlAuthType: 'NONE',
      }),
    ),
    'ResourceConflictException',
  );
  await tolerate(
    lambda.send(
      new AddPermissionCommand({
        FunctionName: fn,
        StatementId: 'PublicInvokeViaFunctionUrl',
        Action: 'lambda:InvokeFunction',
        Principal: '*',
        InvokedViaFunctionUrl: true,
      }),
    ),
    'ResourceConflictException',
  );
  return url;
}
