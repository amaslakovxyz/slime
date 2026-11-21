// provision/reconfigure/teardown against fake AWS clients: every client records
// the command class and input in one shared log, so tests can assert the exact order.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { Config } from '../src/config.js';
import type { Deps, Endpoint } from '../src/deps.js';
import { dispatch } from '../src/handler.js';
import { provision, USAGE_ATTRIBUTES } from '../src/provision.js';
import { reconfigure } from '../src/reconfigure.js';
import { teardown } from '../src/teardown.js';

const config: Config = {
  controlTable: 'slime-control',
  handlersTable: 'slime-handlers',
  gasLayerArn: 'arn:aws:lambda:eu-central-1:123456789012:layer:slime-gas:7',
  boundaryArn: 'arn:aws:iam::123456789012:policy/slime-endpoint-boundary',
  shimZipB64: Buffer.from('shim').toString('base64'),
  sharedSsmPrefix: '/slime/shared/',
  logRetentionDays: 14,
  partition: 'aws',
  region: 'eu-central-1',
  account: '123456789012',
};

const URL = 'https://abc123.lambda-url.eu-central-1.on.aws/';
const TOKEN = 'slm_secret';

const endpoint = (status: Endpoint['status']): Endpoint => ({
  type: 'endpoint',
  endpointId: 'ep-a1b2c3d4e5',
  owner: 'demo@slime.dev',
  name: 'shop',
  provider: 'offline',
  status,
  tokenHint: 'cret',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
});

/** The stream image the admin's PutItem/UpdateItem produces: key plus attributes. */
const streamImage = (status: Endpoint['status'], key = { pk: 'USER#demo@slime.dev', sk: 'ENDPOINT#ep-a1b2c3d4e5' }) =>
  marshall({ ...key, ...endpoint(status) });

const awsError = (name: string, message = name) => Object.assign(new Error(message), { name });

type Call = { command: string; input: any };
/** Per command class name: the response, or a function of the input and the call count (may throw). */
type Responders = Record<string, (input: any, n: number) => any>;

function fakeDeps(on: Responders = {}, health: (n: number) => Response = () => new Response('{"ok":true}', { status: 200 })) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const counts = new Map<string, number>();
  const respond = (command: string, input: any) => {
    calls.push({ command, input });
    const n = (counts.get(command) ?? 0) + 1;
    counts.set(command, n);
    return on[command]?.(input, n) ?? defaults[command]?.(input, n) ?? {};
  };
  const defaults: Responders = {
    CreateFunctionUrlConfigCommand: () => ({ FunctionUrl: URL }),
    GetParameterCommand: () => ({ Parameter: { Value: TOKEN } }),
  };
  const client = { send: async (cmd: any) => respond(cmd.constructor.name, cmd.input) };
  const deps: Deps = {
    config,
    ddb: client,
    iam: client,
    lambda: client,
    logs: client,
    ssm: client,
    fetch: async (url, init) => {
      const n = calls.filter((c) => c.command === 'fetch').length + 1;
      calls.push({ command: 'fetch', input: { url, headers: init.headers } });
      return health(n);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    waitActive: async (FunctionName) => {
      calls.push({ command: 'waitActive', input: { FunctionName } });
    },
    waitUpdated: async (FunctionName) => {
      calls.push({ command: 'waitUpdated', input: { FunctionName } });
    },
  };
  return { deps, calls, sleeps, names: () => calls.map((c) => c.command) };
}

const last = (calls: Call[]) => calls.at(-1)!;

describe('provision', () => {
  test('happy path runs every step in order and ends ready with the URL', async () => {
    const { deps, calls, names } = fakeDeps();
    await provision(endpoint('pending'), deps);

    assert.deepEqual(names(), [
      'UpdateCommand',
      'CreateLogGroupCommand',
      'PutRetentionPolicyCommand',
      'CreateRoleCommand',
      'PutRolePolicyCommand',
      'CreateFunctionCommand',
      'waitActive',
      'CreateFunctionUrlConfigCommand',
      'AddPermissionCommand',
      'AddPermissionCommand',
      'GetParameterCommand',
      'fetch',
      'UpdateCommand',
    ]);

    const claim = calls[0].input;
    assert.deepEqual(claim.Key, { pk: 'USER#demo@slime.dev', sk: 'ENDPOINT#ep-a1b2c3d4e5' });
    assert.equal(claim.ConditionExpression, '#s = :pending');
    assert.equal(claim.ExpressionAttributeValues[':provisioning'], 'provisioning');

    const role = calls.find((c) => c.command === 'CreateRoleCommand')!.input;
    assert.equal(role.RoleName, 'slime-ep-a1b2c3d4e5');
    assert.equal(role.PermissionsBoundary, config.boundaryArn);

    const policy = JSON.parse(calls.find((c) => c.command === 'PutRolePolicyCommand')!.input.PolicyDocument);
    const liquid = policy.Statement.find((s: any) => s.Sid === 'Liquid');
    assert.equal(liquid.Resource, 'arn:aws:dynamodb:eu-central-1:123456789012:table/slime-handlers');
    assert.deepEqual(liquid.Condition['ForAllValues:StringEquals']['dynamodb:LeadingKeys'], ['ep-a1b2c3d4e5']);
    // What the runtime's DynamoSlimeStore sends (slime-cloud/runtime/src/store-dynamodb.ts).
    assert.deepEqual(liquid.Action, ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem']);
    const usage = policy.Statement.find((s: any) => s.Sid === 'Usage');
    assert.deepEqual(usage.Condition['ForAllValues:StringEquals']['dynamodb:LeadingKeys'], ['USAGE#ep-a1b2c3d4e5']);
    assert.deepEqual(usage.Condition['ForAllValues:StringEquals']['dynamodb:Attributes'], [...USAGE_ATTRIBUTES]);

    const fn = calls.find((c) => c.command === 'CreateFunctionCommand')!.input;
    assert.equal(fn.Role, 'arn:aws:iam::123456789012:role/slime-ep-a1b2c3d4e5');
    assert.deepEqual(fn.Layers, [config.gasLayerArn]);
    assert.deepEqual(fn.Environment.Variables, {
      SLIME_SSM_PREFIX: '/slime/shared/,/slime/endpoints/ep-a1b2c3d4e5/',
      SLIME_HANDLERS_TABLE: 'slime-handlers',
      SLIME_TENANT_ID: 'ep-a1b2c3d4e5',
      SLIME_USAGE_TABLE: 'slime-control',
      SLIME_PROVIDER: 'offline',
      SLIME_CRYSTAL_DIR: '/opt/slime/crystal',
      SLIME_OFFLINE_FILE: '/opt/slime/offline/handlers.json',
    });

    const perms = calls.filter((c) => c.command === 'AddPermissionCommand').map((c) => c.input);
    assert.deepEqual(
      perms.map((p) => [p.StatementId, p.Action, p.FunctionUrlAuthType, p.InvokedViaFunctionUrl]),
      [
        ['PublicFunctionUrl', 'lambda:InvokeFunctionUrl', 'NONE', undefined],
        ['PublicInvokeViaFunctionUrl', 'lambda:InvokeFunction', undefined, true],
      ],
    );

    const probe = calls.find((c) => c.command === 'fetch')!.input;
    assert.equal(probe.url, `${URL}healthz`);
    assert.deepEqual(probe.headers, { 'x-api-key': TOKEN });

    const done = last(calls).input;
    assert.deepEqual(done.Key, claim.Key);
    assert.match(done.UpdateExpression, /REMOVE #err/);
    assert.equal(done.ExpressionAttributeValues[':s'], 'ready');
    assert.equal(done.ExpressionAttributeValues[':url'], URL);
    assert.equal(done.ExpressionAttributeValues[':layer'], config.gasLayerArn);
  });

  test('retries CreateFunction while the new role cannot be assumed yet', async () => {
    const { deps, calls, sleeps } = fakeDeps({
      CreateFunctionCommand: (_input, n) => {
        if (n <= 2) throw awsError('InvalidParameterValueException', 'The role defined for the function cannot be assumed by Lambda.');
        return {};
      },
    });
    await provision(endpoint('pending'), deps);

    assert.equal(calls.filter((c) => c.command === 'CreateFunctionCommand').length, 3);
    assert.deepEqual(sleeps, [3000, 3000]);
    assert.equal(last(calls).input.ExpressionAttributeValues[':s'], 'ready');
  });

  test('a healthz answering 503 five times ends failed with the body as the error', async () => {
    const { deps, calls, sleeps } = fakeDeps({}, () => new Response('database is not read-only', { status: 503 }));
    await provision(endpoint('pending'), deps);

    assert.equal(calls.filter((c) => c.command === 'fetch').length, 5);
    assert.deepEqual(sleeps, [3000, 3000, 3000, 3000]);
    const done = last(calls).input;
    assert.equal(done.ExpressionAttributeValues[':s'], 'failed');
    assert.equal(done.ExpressionAttributeValues[':e'], 'database is not read-only');
    assert.equal(done.ExpressionAttributeValues[':url'], URL);
  });

  test('an endpoint that is no longer pending is left alone', async () => {
    const { deps, names } = fakeDeps({
      UpdateCommand: () => {
        throw awsError('ConditionalCheckFailedException');
      },
    });
    await provision(endpoint('pending'), deps);
    assert.deepEqual(names(), ['UpdateCommand']);
  });

  test('tolerates a log group, role, function, URL and permissions that already exist', async () => {
    const { deps, calls } = fakeDeps({
      CreateLogGroupCommand: () => {
        throw awsError('ResourceAlreadyExistsException');
      },
      CreateRoleCommand: () => {
        throw awsError('EntityAlreadyExistsException');
      },
      CreateFunctionCommand: () => {
        throw awsError('ResourceConflictException');
      },
      CreateFunctionUrlConfigCommand: () => {
        throw awsError('ResourceConflictException');
      },
      GetFunctionUrlConfigCommand: () => ({ FunctionUrl: URL }),
      AddPermissionCommand: () => {
        throw awsError('ResourceConflictException');
      },
    });
    await provision(endpoint('pending'), deps);

    assert.ok(calls.some((c) => c.command === 'GetFunctionUrlConfigCommand'));
    const done = last(calls).input;
    assert.equal(done.ExpressionAttributeValues[':s'], 'ready');
    assert.equal(done.ExpressionAttributeValues[':url'], URL);
  });

  test('the endpoint role may write exactly the usage attributes the runtime flushes', () => {
    // Contract: slime-cloud v2 section 1. A missing attribute makes every flush
    // fail AccessDenied; an extra one widens what the role can shape.
    assert.deepEqual(
      [...USAGE_ATTRIBUTES].sort(),
      [
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
      ].sort(),
    );
  });
});

describe('reconfigure', () => {
  const existingEnv = {
    SLIME_SSM_PREFIX: '/slime/shared/,/slime/endpoints/ep-a1b2c3d4e5/',
    SLIME_TENANT_ID: 'ep-a1b2c3d4e5',
    SLIME_PROVIDER: 'offline',
    SLIME_CONFIG_VERSION: '2026-11-19T00:00:00.000Z',
  };
  const updating = (): Endpoint => ({ ...endpoint('updating'), provider: 'groq', updatedAt: '2026-11-21T10:00:00.000Z' });
  const lambdaState: Responders = {
    GetFunctionConfigurationCommand: () => ({ Environment: { Variables: existingEnv } }),
    GetFunctionUrlConfigCommand: () => ({ FunctionUrl: URL }),
  };

  test('an updating stream record merges the env, waits for the update, probes healthz and ends ready', async () => {
    const { deps, calls, names } = fakeDeps(lambdaState);
    await dispatch({ Records: [{ eventName: 'MODIFY', dynamodb: { NewImage: marshall({ pk: 'USER#demo@slime.dev', sk: 'ENDPOINT#ep-a1b2c3d4e5', ...updating() }) } }] }, deps);

    assert.deepEqual(names(), [
      'UpdateCommand',
      'GetFunctionConfigurationCommand',
      'UpdateFunctionConfigurationCommand',
      'waitUpdated',
      'GetFunctionUrlConfigCommand',
      'GetParameterCommand',
      'fetch',
      'UpdateCommand',
    ]);

    const claim = calls[0].input;
    assert.equal(claim.ConditionExpression, '#s = :updating');
    assert.equal(claim.ExpressionAttributeValues[':provisioning'], 'provisioning');

    const update = calls.find((c) => c.command === 'UpdateFunctionConfigurationCommand')!.input;
    assert.equal(update.FunctionName, 'slime-ep-a1b2c3d4e5');
    assert.deepEqual(update.Environment.Variables, {
      SLIME_SSM_PREFIX: '/slime/shared/,/slime/endpoints/ep-a1b2c3d4e5/',
      SLIME_TENANT_ID: 'ep-a1b2c3d4e5',
      SLIME_PROVIDER: 'groq',
      SLIME_CONFIG_VERSION: '2026-11-21T10:00:00.000Z',
    });
    assert.deepEqual(calls.find((c) => c.command === 'waitUpdated')!.input, { FunctionName: 'slime-ep-a1b2c3d4e5' });
    assert.equal(calls.find((c) => c.command === 'fetch')!.input.url, `${URL}healthz`);

    const done = last(calls).input;
    assert.deepEqual(done.Key, claim.Key);
    assert.match(done.UpdateExpression, /REMOVE #err/);
    assert.equal(done.ExpressionAttributeValues[':s'], 'ready');
    assert.equal(done.ExpressionAttributeValues[':url'], URL);
  });

  test('retries UpdateFunctionConfiguration while a previous update is in progress', async () => {
    const { deps, calls, sleeps } = fakeDeps({
      ...lambdaState,
      UpdateFunctionConfigurationCommand: (_input, n) => {
        if (n <= 2) throw awsError('ResourceConflictException', 'An update is in progress for resource');
        return {};
      },
    });
    await reconfigure(updating(), deps);

    assert.equal(calls.filter((c) => c.command === 'UpdateFunctionConfigurationCommand').length, 3);
    assert.deepEqual(sleeps, [3000, 3000]);
    assert.equal(last(calls).input.ExpressionAttributeValues[':s'], 'ready');
  });

  test('an endpoint that is no longer updating is left alone', async () => {
    const { deps, names } = fakeDeps({
      ...lambdaState,
      UpdateCommand: () => {
        throw awsError('ConditionalCheckFailedException');
      },
    });
    await reconfigure(updating(), deps);
    assert.deepEqual(names(), ['UpdateCommand']);
  });

  test('a healthz that keeps failing ends failed with the body as the error', async () => {
    const { deps, calls } = fakeDeps(lambdaState, () => new Response('connection refused', { status: 502 }));
    await reconfigure(updating(), deps);

    assert.equal(calls.filter((c) => c.command === 'fetch').length, 5);
    const done = last(calls).input;
    assert.equal(done.ExpressionAttributeValues[':s'], 'failed');
    assert.equal(done.ExpressionAttributeValues[':e'], 'connection refused');
    assert.doesNotMatch(done.UpdateExpression, /REMOVE/);
  });

  test('a failed update ends failed without probing healthz', async () => {
    const { deps, calls, names } = fakeDeps({
      ...lambdaState,
      UpdateFunctionConfigurationCommand: () => {
        throw awsError('AccessDeniedException', 'not authorized');
      },
    });
    await reconfigure(updating(), deps);

    assert.ok(!names().includes('fetch'));
    const done = last(calls).input;
    assert.equal(done.ExpressionAttributeValues[':s'], 'failed');
    assert.equal(done.ExpressionAttributeValues[':e'], 'not authorized');
  });
});

describe('teardown', () => {
  test('a deleting stream record removes everything, Liquid in batches of 25, the control item last', async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ tenantId: 'ep-a1b2c3d4e5', artifactKey: `k${String(i).padStart(2, '0')}` }));
    const { deps, calls, names } = fakeDeps({
      // Two pages, so paging is followed before anything is deleted.
      QueryCommand: (input) =>
        input.ExclusiveStartKey ? { Items: items.slice(20) } : { Items: items.slice(0, 20), LastEvaluatedKey: items[19] },
      GetParametersByPathCommand: () => ({
        Parameters: [{ Name: '/slime/endpoints/ep-a1b2c3d4e5/DATABASE_URL' }, { Name: '/slime/endpoints/ep-a1b2c3d4e5/SLIME_API_KEY' }],
      }),
      DeleteRolePolicyCommand: () => {
        throw awsError('NoSuchEntityException');
      },
      DeleteLogGroupCommand: () => {
        throw awsError('ResourceNotFoundException');
      },
    });
    await dispatch({ Records: [{ eventName: 'MODIFY', dynamodb: { NewImage: streamImage('deleting') } }] }, deps);

    assert.deepEqual(names(), [
      'DeleteFunctionUrlConfigCommand',
      'DeleteFunctionCommand',
      'DeleteRolePolicyCommand',
      'DeleteRoleCommand',
      'DeleteLogGroupCommand',
      'GetParametersByPathCommand',
      'DeleteParametersCommand',
      'QueryCommand',
      'QueryCommand',
      'BatchWriteCommand',
      'BatchWriteCommand',
      'DeleteCommand',
    ]);
    const batches = calls.filter((c) => c.command === 'BatchWriteCommand').map((c) => c.input.RequestItems['slime-handlers']);
    assert.deepEqual(
      batches.map((b) => b.length),
      [25, 5],
    );
    assert.deepEqual(
      batches.flat().map((r: any) => r.DeleteRequest.Key),
      items,
    );
    assert.deepEqual(calls.find((c) => c.command === 'DeleteParametersCommand')!.input.Names, [
      '/slime/endpoints/ep-a1b2c3d4e5/DATABASE_URL',
      '/slime/endpoints/ep-a1b2c3d4e5/SLIME_API_KEY',
    ]);
    assert.deepEqual(last(calls).input, {
      TableName: 'slime-control',
      Key: { pk: 'USER#demo@slime.dev', sk: 'ENDPOINT#ep-a1b2c3d4e5' },
    });
  });

  test('ignores an image whose key is not that endpoint item (forged through a USAGE# partition)', async () => {
    const { deps, calls } = fakeDeps({});
    await dispatch(
      {
        Records: [
          { eventName: 'MODIFY', dynamodb: { NewImage: streamImage('deleting', { pk: 'USAGE#ep-ffffffffff', sk: '2026-11' }) } },
          { eventName: 'MODIFY', dynamodb: { NewImage: streamImage('pending', { pk: 'USER#other@slime.dev', sk: 'ENDPOINT#ep-a1b2c3d4e5' }) } },
        ],
      },
      deps,
    );
    assert.deepEqual(calls, []);
  });

  test('a failing step marks the endpoint failed so it can be deleted again', async () => {
    const { deps, calls } = fakeDeps({
      DeleteFunctionCommand: () => {
        throw awsError('TooManyRequestsException', 'Rate exceeded');
      },
    });
    await teardown(endpoint('deleting'), deps);

    const done = last(calls);
    assert.equal(done.command, 'UpdateCommand');
    assert.equal(done.input.ExpressionAttributeValues[':s'], 'failed');
    assert.equal(done.input.ExpressionAttributeValues[':e'], 'Delete failed: Rate exceeded');
  });
});
