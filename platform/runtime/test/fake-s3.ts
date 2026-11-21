// Just enough of a versioned S3 bucket for the Crystal store: Get/Head/Put with
// ETags and IfMatch / IfNoneMatch (412), ListObjectVersions in pages of
// `pageSize`, and DeleteObjects by version. Puts are recorded in order.
import { createHash } from 'node:crypto';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
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
  readonly #pageSize: number;
  #nextVersion = 1;

  constructor(pageSize = 1_000) {
    this.#pageSize = pageSize;
  }

  /** Current object text, or undefined. */
  text(key: string): string | undefined {
    return this.versions.get(key)?.at(-1)?.body;
  }

  keys(): string[] {
    return [...this.versions.keys()].sort();
  }

  async send(command: GetObjectCommand | PutObjectCommand | HeadObjectCommand | ListObjectVersionsCommand | DeleteObjectsCommand): Promise<any> {
    if (command instanceof GetObjectCommand || command instanceof HeadObjectCommand) {
      const current = this.versions.get(command.input.Key ?? '')?.at(-1);
      if (!current) throw command instanceof GetObjectCommand ? s3Error('NoSuchKey', 404) : s3Error('NotFound', 404);
      return command instanceof GetObjectCommand
        ? { ETag: current.etag, Body: { transformToString: async () => current.body } }
        : { ETag: current.etag };
    }
    if (command instanceof PutObjectCommand) return this.#put(command);
    if (command instanceof ListObjectVersionsCommand) return this.#list(command);
    return this.#delete(command);
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

  #list(command: ListObjectVersionsCommand): Record<string, unknown> {
    const { Prefix = '', KeyMarker, VersionIdMarker } = command.input;
    const all = this.keys()
      .filter((key) => key.startsWith(Prefix))
      .flatMap((key) => this.versions.get(key)!.map(({ versionId }) => ({ Key: key, VersionId: versionId })));
    const start = KeyMarker ? all.findIndex((v) => v.Key === KeyMarker && v.VersionId === VersionIdMarker) + 1 : 0;
    const page = all.slice(start, start + this.#pageSize);
    const isTruncated = start + this.#pageSize < all.length;
    const last = page.at(-1);
    return { Versions: page, IsTruncated: isTruncated, ...(isTruncated && last ? { NextKeyMarker: last.Key, NextVersionIdMarker: last.VersionId } : {}) };
  }

  #delete(command: DeleteObjectsCommand): Record<string, unknown> {
    for (const { Key = '', VersionId } of command.input.Delete?.Objects ?? []) {
      const left = (this.versions.get(Key) ?? []).filter((v) => v.versionId !== VersionId);
      if (left.length > 0) this.versions.set(Key, left);
      else this.versions.delete(Key);
    }
    return { Errors: [] };
  }
}
