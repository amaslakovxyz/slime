// An in-memory versioned bucket answering the two calls teardown makes. Listing
// pages two entries at a time, so teardown's paging is exercised.
import { DeleteObjectsCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import type { CrystalObjects } from '../lib/teardown';

export interface StoredVersion {
  Key: string;
  VersionId: string;
  deleteMarker?: boolean;
}

const PAGE = 2;

export class FakeS3 implements CrystalObjects {
  readonly versions: StoredVersion[] = [];
  readonly calls: string[] = [];
  /** Set to make every DeleteObjects call fail, as a lost permission would. */
  failDeletes = false;
  /** Runs before each call, so a test can look at the world at that moment. */
  onCall?: (name: string) => Promise<void>;

  put(Key: string, deleteMarker = false): void {
    this.versions.push({ Key, VersionId: `v${this.versions.length + 1}`, deleteMarker });
  }

  keys(prefix = ''): string[] {
    return this.versions.filter((v) => v.Key.startsWith(prefix)).map((v) => `${v.Key}@${v.VersionId}`);
  }

  async send(command: ListObjectVersionsCommand | DeleteObjectsCommand): Promise<any> {
    const name = command instanceof ListObjectVersionsCommand ? 'ListObjectVersions' : 'DeleteObjects';
    this.calls.push(name);
    await this.onCall?.(name);
    if (command instanceof ListObjectVersionsCommand) {
      const { Prefix = '', KeyMarker } = command.input;
      const matching = this.versions.filter((v) => v.Key.startsWith(Prefix));
      const start = KeyMarker ? Number(KeyMarker) : 0;
      const page = matching.slice(start, start + PAGE);
      const truncated = start + PAGE < matching.length;
      return {
        Versions: page.filter((v) => !v.deleteMarker).map(({ Key, VersionId }) => ({ Key, VersionId })),
        DeleteMarkers: page.filter((v) => v.deleteMarker).map(({ Key, VersionId }) => ({ Key, VersionId })),
        IsTruncated: truncated,
        // Opaque to the caller, which only hands markers back.
        ...(truncated ? { NextKeyMarker: String(start + PAGE), NextVersionIdMarker: 'opaque' } : {}),
      };
    }
    if (this.failDeletes) throw new Error('AccessDenied');
    for (const { Key, VersionId } of command.input.Delete?.Objects ?? []) {
      const index = this.versions.findIndex((v) => v.Key === Key && v.VersionId === VersionId);
      if (index >= 0) this.versions.splice(index, 1);
    }
    return { Errors: [] };
  }
}
