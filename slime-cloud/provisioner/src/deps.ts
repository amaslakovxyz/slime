// What provision/teardown talk to. Each client is the slice of its SDK client
// that the worker uses, so tests pass fakes with a send() method; fetch, sleep
// and the function-active waiter are injected for the same reason.
import { CloudWatchLogsClient, type CreateLogGroupCommand, type DeleteLogGroupCommand, type PutRetentionPolicyCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { IAMClient, type CreateRoleCommand, type DeleteRoleCommand, type DeleteRolePolicyCommand, type PutRolePolicyCommand } from '@aws-sdk/client-iam';
import {
  LambdaClient,
  waitUntilFunctionActiveV2,
  type AddPermissionCommand,
  type CreateFunctionCommand,
  type CreateFunctionUrlConfigCommand,
  type DeleteFunctionCommand,
  type DeleteFunctionUrlConfigCommand,
  type GetFunctionUrlConfigCommand,
} from '@aws-sdk/client-lambda';
import { SSMClient, type DeleteParametersCommand, type GetParameterCommand, type GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, type BatchWriteCommand, type DeleteCommand, type QueryCommand, type UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, type Config } from './config.js';

/** The endpoint item of slime-control, as the stream delivers it (see plan step 2). */
export interface Endpoint {
  type: 'endpoint';
  endpointId: string;
  owner: string;
  name: string;
  provider: 'claude' | 'groq' | 'offline';
  status: 'pending' | 'provisioning' | 'ready' | 'failed' | 'deleting';
  tokenHint?: string;
  url?: string;
  layerArn?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Deps {
  config: Config;
  ddb: { send(command: UpdateCommand | DeleteCommand | QueryCommand | BatchWriteCommand): Promise<any> };
  iam: { send(command: CreateRoleCommand | PutRolePolicyCommand | DeleteRolePolicyCommand | DeleteRoleCommand): Promise<any> };
  lambda: {
    send(
      command:
        | CreateFunctionCommand
        | CreateFunctionUrlConfigCommand
        | GetFunctionUrlConfigCommand
        | AddPermissionCommand
        | DeleteFunctionUrlConfigCommand
        | DeleteFunctionCommand,
    ): Promise<any>;
  };
  logs: { send(command: CreateLogGroupCommand | PutRetentionPolicyCommand | DeleteLogGroupCommand): Promise<any> };
  ssm: { send(command: GetParameterCommand | GetParametersByPathCommand | DeleteParametersCommand): Promise<any> };
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  /** Resolves once the function is Active; throws if it never gets there. */
  waitActive: (functionName: string) => Promise<void>;
}

export function defaultDeps(config: Config = loadConfig()): Deps {
  const lambda = new LambdaClient({});
  return {
    config,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
    iam: new IAMClient({}),
    lambda,
    logs: new CloudWatchLogsClient({}),
    ssm: new SSMClient({}),
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => sleep(ms),
    waitActive: async (FunctionName) => {
      await waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 120 }, { FunctionName });
    },
  };
}

// Names every piece of an endpoint shares. The bootstrap CI fences only allow
// slime-* IAM/Lambda names and /slime/* parameters, so the prefixes are fixed.

/** ep-a1b2c3d4e5 -> slime-ep-a1b2c3d4e5 (function, role and log group name). */
export function functionName(endpointId: string): string {
  return `slime-${endpointId}`;
}

export function logGroupName(endpointId: string): string {
  return `/aws/lambda/${functionName(endpointId)}`;
}

/** Path of the endpoint's secrets (DATABASE_URL, SLIME_API_KEY), trailing slash included. */
export function secretsPath(endpointId: string): string {
  return `/slime/endpoints/${endpointId}/`;
}

export function endpointKey(ep: Pick<Endpoint, 'owner' | 'endpointId'>) {
  return { pk: `USER#${ep.owner}`, sk: `ENDPOINT#${ep.endpointId}` };
}

export function errorName(err: unknown): string | undefined {
  return (err as { name?: string } | null)?.name;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs `op`; an error whose name is in `names` counts as success (undefined). */
export async function tolerate<T>(op: Promise<T>, ...names: string[]): Promise<T | undefined> {
  try {
    return await op;
  } catch (err) {
    if (names.includes(errorName(err) ?? '')) return undefined;
    throw err;
  }
}
