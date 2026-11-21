// slime-admin Lambda entry (run.sh execs it): loads the admin's own settings
// (SESSION_SECRET, ADMIN_ALLOWED_EMAILS) from SSM under SLIME_ADMIN_SSM_PREFIX into
// process.env, then starts Next's standalone server. Writing process.env is fine
// here: the admin is single-tenant, unlike the shared runtime. Without the prefix
// (a local run of dist/lambda) the environment is used as is.
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';

const prefix = process.env.SLIME_ADMIN_SSM_PREFIX;
if (prefix) {
  const ssm = new SSMClient({});
  let NextToken;
  do {
    const page = await ssm.send(new GetParametersByPathCommand({ Path: prefix, WithDecryption: true, NextToken }));
    for (const { Name, Value } of page.Parameters ?? []) {
      if (Name && Value !== undefined) process.env[Name.slice(Name.lastIndexOf('/') + 1)] = Value;
    }
    NextToken = page.NextToken;
  } while (NextToken);
}

await import('./server.js');
