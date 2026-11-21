// Endpoint secrets (customer DATABASE_URL, endpoint API key). They never go into
// slime-control: in AWS they live in SSM SecureString where the endpoint's
// runtime loads them; locally they live in a git-ignored 0600 JSON file.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DeleteParametersCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import { env } from './env';

export interface PutOptions {
  /** Replace an existing value; without it a second put of the same name fails. */
  overwrite?: boolean;
}

export interface SecretStore {
  put(endpointId: string, name: string, value: string, options?: PutOptions): Promise<void>;
  get(endpointId: string, name: string): Promise<string | undefined>;
  removeAll(endpointId: string): Promise<void>;
}

const prefixFor = (endpointId: string) => `/slime/endpoints/${endpointId}/`;
export const secretPath = (endpointId: string, name: string) => prefixFor(endpointId) + name;

class SsmSecretStore implements SecretStore {
  private readonly client = new SSMClient({});

  async put(endpointId: string, name: string, value: string, options: PutOptions = {}): Promise<void> {
    await this.client.send(
      new PutParameterCommand({
        Name: secretPath(endpointId, name),
        Value: value,
        Type: 'SecureString',
        Overwrite: options.overwrite === true,
      }),
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

/** One mutation queue per secrets file: the admin and the runner both run several mutations at once. */
const fileQueues = new Map<string, Promise<unknown>>();
const LOCK_RETRY_MS = 25;
/** A load-change-save takes milliseconds; a lock older than this was left by a crashed writer. */
const LOCK_STALE_MS = 5_000;

class FileSecretStore implements SecretStore {
  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, string>> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    try {
      return JSON.parse(text) as Record<string, string>;
    } catch {
      // Never let a parse error echo the file (it holds secrets) into logs.
      throw new Error(`Secret file ${this.file} is not valid JSON`);
    }
  }

  /** Write a temp file, then rename: a reader sees the old file or the new one, never half of one. */
  private async save(data: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }

  /**
   * The admin (next dev) and the runner are two processes writing one file: an exclusive lock file
   * keeps one process's load-change-save from overwriting the other's.
   */
  private async withFileLock(work: () => Promise<void>): Promise<void> {
    const lock = `${this.file}.lock`;
    await mkdir(dirname(this.file), { recursive: true });
    for (;;) {
      try {
        await (await open(lock, 'wx')).close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) await rm(lock, { force: true });
        else await sleep(LOCK_RETRY_MS);
      }
    }
    try {
      await work();
    } finally {
      await rm(lock, { force: true });
    }
  }

  /** Load-change-save, one at a time per file: queued within this process, locked across processes. */
  private mutate(change: (data: Record<string, string>) => void): Promise<void> {
    const previous = fileQueues.get(this.file) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() =>
      this.withFileLock(async () => {
        const data = await this.load();
        change(data);
        await this.save(data);
      }),
    );
    fileQueues.set(this.file, next);
    return next;
  }

  async put(endpointId: string, name: string, value: string, options: PutOptions = {}): Promise<void> {
    const path = secretPath(endpointId, name);
    await this.mutate((data) => {
      // Same contract as SSM's Overwrite:false (ParameterAlreadyExists).
      if (path in data && !options.overwrite) throw new Error(`Secret ${path} already exists`);
      data[path] = value;
    });
  }

  async get(endpointId: string, name: string): Promise<string | undefined> {
    return (await this.load())[secretPath(endpointId, name)];
  }

  async removeAll(endpointId: string): Promise<void> {
    const prefix = prefixFor(endpointId);
    await this.mutate((data) => {
      for (const key of Object.keys(data)) if (key.startsWith(prefix)) delete data[key];
    });
  }
}

export function secretStore(): SecretStore {
  const { secrets, secretsFile } = env();
  if (secrets === 'ssm') return new SsmSecretStore();
  if (secrets === 'file') return new FileSecretStore(secretsFile);
  throw new Error(`Unknown SLIME_SECRETS: ${secrets}`);
}
