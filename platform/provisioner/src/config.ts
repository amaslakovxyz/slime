// Provisioner settings, all set by Terraform (platform/infra/platform/provisioner.tf).
// Partition, region and account come from the Gas layer ARN, so the env list
// stays the plan's and table/parameter ARNs need no extra variables.

export interface Config {
  controlTable: string;
  handlersTable: string;
  gasLayerArn: string;
  boundaryArn: string;
  /** The endpoint shim zip (shim/index.mjs), base64. */
  shimZipB64: string;
  /** e.g. "/slime/shared/": parameters every endpoint loads (provider API keys). */
  sharedSsmPrefix: string;
  logRetentionDays: number;
  partition: string;
  region: string;
  account: string;
}

export const ENV_NAMES = [
  'SLIME_CONTROL_TABLE',
  'SLIME_HANDLERS_TABLE',
  'SLIME_GAS_LAYER_ARN',
  'SLIME_ENDPOINT_BOUNDARY_ARN',
  'SLIME_ENDPOINT_SHIM_ZIP_B64',
  'SLIME_SHARED_SSM_PREFIX',
  'SLIME_LOG_RETENTION_DAYS',
] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ENV_NAMES.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
  const get = (name: (typeof ENV_NAMES)[number]) => env[name] as string;

  // arn:<partition>:lambda:<region>:<account>:layer:<name>:<version>
  const [arn, partition, service, region, account] = get('SLIME_GAS_LAYER_ARN').split(':');
  if (arn !== 'arn' || service !== 'lambda' || !region || !account) {
    throw new Error('SLIME_GAS_LAYER_ARN is not a Lambda layer version ARN');
  }
  const logRetentionDays = Number(get('SLIME_LOG_RETENTION_DAYS'));
  if (!Number.isInteger(logRetentionDays) || logRetentionDays <= 0) {
    throw new Error('SLIME_LOG_RETENTION_DAYS must be a positive integer');
  }

  return {
    controlTable: get('SLIME_CONTROL_TABLE'),
    handlersTable: get('SLIME_HANDLERS_TABLE'),
    gasLayerArn: get('SLIME_GAS_LAYER_ARN'),
    boundaryArn: get('SLIME_ENDPOINT_BOUNDARY_ARN'),
    shimZipB64: get('SLIME_ENDPOINT_SHIM_ZIP_B64'),
    sharedSsmPrefix: get('SLIME_SHARED_SSM_PREFIX'),
    logRetentionDays,
    partition,
    region,
    account,
  };
}
