// slime-atlas Lambda entry (platform/infra/atlas): the same app as server.mjs
// behind a public Function URL. SLIME_URL, SLIME_API_KEY and CRYSTAL_* come
// from SSM under ATLAS_SSM_PREFIX at cold start, so keys never sit in Terraform
// state or the Lambda console. @aws-sdk/client-ssm ships with the Node runtime.
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { handle } from 'hono/aws-lambda';
import { createApp } from './app.mjs';

async function loadSettings(prefix) {
  const settings = {};
  if (!prefix) return settings;
  const ssm = new SSMClient({});
  let NextToken;
  do {
    const page = await ssm.send(new GetParametersByPathCommand({ Path: prefix, WithDecryption: true, NextToken }));
    for (const { Name, Value } of page.Parameters ?? []) settings[Name.slice(Name.lastIndexOf('/') + 1)] = Value;
    NextToken = page.NextToken;
  } while (NextToken);
  return settings;
}

export const handler = handle(createApp({ env: { ...process.env, ...(await loadSettings(process.env.ATLAS_SSM_PREFIX)) } }));
