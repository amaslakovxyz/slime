// Endpoint secrets (customer DATABASE_URL, endpoint API key). They never go into
// slime-control: in AWS they live in SSM SecureString where the endpoint's
// runtime loads them; locally they live in a git-ignored 0600 JSON file.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  DeleteParametersCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import { env } from './env';

export interface SecretStore {
  put(endpointId: string, name: string, value: string): Promise<void>;
  get(endpointId: string, name: string): Promise<string | undefined>;
  removeAll(endpointId: string): Promise<void>;
}

const prefixFor = (endpointId: string) => `/slime/endpoints/${endpointId}/`;
export const secretPath = (endpointId: string, name: string) => prefixFor(endpointId) + name;

class SsmSecretStore implements SecretStore {
  private readonly client = new SSMClient({});

  async put(endpointId: string, name: string, value: string): Promise<void> {
    await this.client.send(
      new PutParameterCommand({ Name: secretPath(endpointId, name), Value: value, Type: 'SecureString', Overwrite: false }),
    );
  }

  async get(endpointId: string, name: string): Promise<string | undefined> {
    try {
      const out = await this.client.send(new GetParameterCommand({ Name: secretPath(endpointId, name), WithDecryption: true }));
      return out.Parameter?.Value;
    } catch (err) {
      if (err instanceof ParameterNotFound) return undefined;
      throw err;
    }
  }

  async removeAll(endpointId: string): Promise<void> {
    const names: string[] = [];
    let NextToken: string | undefined;
    do {
      const page = await this.client.send(new GetParametersByPathCommand({ Path: prefixFor(endpointId), NextToken }));
      for (const p of page.Parameters ?? []) if (p.Name) names.push(p.Name);
      NextToken = page.NextToken;
    } while (NextToken);
    // DeleteParameters takes at most 10 names per call.
    for (let i = 0; i < names.length; i += 10) {
      await this.client.send(new DeleteParametersCommand({ Names: names.slice(i, i + 10) }));
    }
  }
}

class FileSecretStore implements SecretStore {
  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  private async save(data: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    // writeFile's mode applies only when it creates the file.
    await chmod(this.file, 0o600);
  }

  async put(endpointId: string, name: string, value: string): Promise<void> {
    const data = await this.load();
    data[secretPath(endpointId, name)] = value;
    await this.save(data);
  }

  async get(endpointId: string, name: string): Promise<string | undefined> {
    return (await this.load())[secretPath(endpointId, name)];
  }

  async removeAll(endpointId: string): Promise<void> {
    const data = await this.load();
    const prefix = prefixFor(endpointId);
    for (const key of Object.keys(data)) if (key.startsWith(prefix)) delete data[key];
    await this.save(data);
  }
}

export function secretStore(): SecretStore {
  const { secrets, secretsFile } = env();
  if (secrets === 'ssm') return new SsmSecretStore();
  if (secrets === 'file') return new FileSecretStore(secretsFile);
  throw new Error(`Unknown SLIME_SECRETS: ${secrets}`);
}
