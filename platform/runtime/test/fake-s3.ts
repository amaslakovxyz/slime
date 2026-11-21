// Just enough of a versioned S3 bucket for the Crystal store: Get/Head/Put with
// ETags and IfMatch / IfNoneMatch (412). Puts are recorded in order.
import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Port } from '../src/crystal-store.js';

interface Version {
  versionId: string;
  body: string;
  etag: string;
}

/** Shaped like the SDK's service errors: a name and the HTTP status. */
function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

export class FakeS3 implements S3Port {
  /** Key -> versions, oldest first; the last one is current. */
  readonly versions = new Map<string, Version[]>();
  /** Keys in the order they were put, with the conditions sent. */
  readonly puts: { key: string; ifMatch?: string; ifNoneMatch?: string }[] = [];
  #nextVersion = 1;

  /** Current object text, or undefined. */
  text(key: string): string | undefined {
    return this.versions.get(key)?.at(-1)?.body;
  }

  keys(): string[] {
    return [...this.versions.keys()].sort();
  }

  async send(command: GetObjectCommand | PutObjectCommand | HeadObjectCommand): Promise<any> {
    if (command instanceof GetObjectCommand || command instanceof HeadObjectCommand) {
      const current = this.versions.get(command.input.Key ?? '')?.at(-1);
      if (!current) throw command instanceof GetObjectCommand ? s3Error('NoSuchKey', 404) : s3Error('NotFound', 404);
      return command instanceof GetObjectCommand
        ? { ETag: current.etag, Body: { transformToString: async () => current.body } }
        : { ETag: current.etag };
    }
    return this.#put(command);
  }

  #put(command: PutObjectCommand): { ETag: string } {
    const { Key = '', Body, IfMatch, IfNoneMatch } = command.input;
    const current = this.versions.get(Key)?.at(-1);
    if (IfNoneMatch === '*' && current) throw s3Error('PreconditionFailed', 412);
    if (IfMatch !== undefined && current?.etag !== IfMatch) throw s3Error('PreconditionFailed', 412);
    const body = String(Body);
    const etag = `"${createHash('md5').update(body).update(String(this.#nextVersion)).digest('hex')}"`;
    this.versions.set(Key, [...(this.versions.get(Key) ?? []), { versionId: `v${this.#nextVersion++}`, body, etag }]);
    this.puts.push({ key: Key, ...(IfMatch ? { ifMatch: IfMatch } : {}), ...(IfNoneMatch ? { ifNoneMatch: IfNoneMatch } : {}) });
    return { ETag: etag };
  }
}
