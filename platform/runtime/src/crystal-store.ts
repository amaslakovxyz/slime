// Where an endpoint's Crystal modules live, and how they load and publish.
//
//   S3CrystalStore  (Lambda) s3://<bucket>/endpoints/<id>/crystal/manifest.json + <crystal key>.mjs
//   DirCrystalStore (local)  the endpoint's Crystal folder (SLIME_CRYSTAL_DIR)
//
// S3 modules are data: each is checked against the manifest's SHA-256, parsed by
// core's parseModule (structure plus the shape allowlist), and served with its
// shape as source text, which the engine runs in its QuickJS sandbox. Nothing read
// from S3 is ever import()ed or evaluated in this process. The local folder is
// imported as before (index.mjs), since it is the operator's own code.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { CrystalHandler, CrystalRegistry } from '@slime-cloud/core';
import { MANIFEST_FILE, moduleFileFor, parseManifest, parseModule, readManifest, type Manifest } from '@slime-cloud/crystal';

/** An endpoint's Crystals as one engine serves them. */
export interface CrystalLoad {
  registry: CrystalRegistry;
  /** The manifest version they came from (S3 ETag); undefined when there is none. */
  etag?: string;
  /** Crystals dropped while loading, for the log and the Lifecycle tab. */
  warnings: string[];
}

/** A folder Crystallize writes into, prepared from what is stored now. */
export interface CrystalWork {
  dir: string;
  /** The manifest version the folder was prepared from: publish fails if another one replaced it. */
  etag?: string;
  /** Crystal keys whose modules are stored already: publish uploads only the others. */
  stored: readonly string[];
}

export interface CrystalStore {
  load(endpointId: string): Promise<CrystalLoad>;
  /** The current manifest version, cheaply: an S3 HEAD, or the manifest's mtime locally. */
  version(endpointId: string): Promise<string | undefined>;
  prepareWork(endpointId: string): Promise<CrystalWork>;
  /** Stores what Crystallize wrote into the work folder; returns the new manifest version. */
  publish(endpointId: string, work: CrystalWork): Promise<string | undefined>;
  /** Deletes the work folder when it is a private copy. */
  discardWork(work: CrystalWork): Promise<void>;
}

/** Another Crystallize published a manifest after this one prepared its work folder. */
export class CrystallizeConflictError extends Error {
  override readonly name = 'CrystallizeConflictError';

  constructor() {
    super('another Crystallize finished first, try again');
  }
}

/**
 * Builds string-shape Crystal handlers from a manifest and its modules' text. A module
 * that is missing, does not match its SHA-256, or fails parseModule is dropped with a
 * warning: one bad Crystal must not take the endpoint down.
 */
export async function crystalsFromManifest(manifest: Manifest, readModule: (file: string) => Promise<string | undefined>): Promise<Omit<CrystalLoad, 'etag'>> {
  const warnings: string[] = [];
  const entries = await Promise.all(
    Object.entries(manifest.entries).map(async ([key, entry]): Promise<[string, CrystalHandler] | undefined> => {
      // The file name is derived from the key, never taken from the manifest as a path.
      const file = moduleFileFor(key);
      const source = entry.file === file ? await readModule(file) : undefined;
      if (source === undefined) {
        warnings.push(`Crystal ${key}: module ${file} is missing; dropped.`);
        return undefined;
      }
      if (sha256(source) !== entry.sha256) {
        warnings.push(`Crystal ${key}: ${file} does not match the SHA-256 in ${MANIFEST_FILE}; dropped.`);
        return undefined;
      }
      try {
        const { sql, params, shape } = parseModule(source);
        const { intent, output, paramTypes, schemaHash, review } = entry;
        return [key, { sql, params, shape, intent, output, paramTypes, schemaHash, review }];
      } catch (error) {
        warnings.push(`Crystal ${key}: ${file} failed the module check (${(error as Error).message}); dropped.`);
        return undefined;
      }
    }),
  );
  return { registry: Object.fromEntries(entries.filter((entry) => entry !== undefined)), warnings };
}

/** A work folder as string-shape handlers: what was just published, without reading it back. */
export async function crystalsFromFolder(dir: string): Promise<Omit<CrystalLoad, 'etag'>> {
  return crystalsFromManifest(await readManifest(dir), (file) => readFile(join(dir, file), 'utf8').catch(() => undefined));
}

/** The slice of S3Client the store uses; tests pass a fake. */
export interface S3Port {
  send(command: GetObjectCommand | PutObjectCommand | HeadObjectCommand): Promise<any>;
}

export interface S3CrystalStoreOptions {
  bucket: string;
  client: S3Port;
  /** Where work folders go; /tmp on Lambda. */
  workRoot?: string;
}

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_PRECONDITION_FAILED = 412;

export class S3CrystalStore implements CrystalStore {
  readonly #bucket: string;
  readonly #client: S3Port;
  readonly #workRoot: string;

  constructor({ bucket, client, workRoot = join(tmpdir(), 'slime') }: S3CrystalStoreOptions) {
    this.#bucket = bucket;
    this.#client = client;
    this.#workRoot = workRoot;
  }

  async load(endpointId: string): Promise<CrystalLoad> {
    const manifest = await this.#get(this.#key(endpointId, MANIFEST_FILE));
    if (!manifest) return { registry: {}, warnings: [] };
    const loaded = await crystalsFromManifest(parseManifest(manifest.text), async (file) => (await this.#get(this.#key(endpointId, file)))?.text);
    return { ...loaded, etag: manifest.etag };
  }

  async version(endpointId: string): Promise<string | undefined> {
    try {
      const head = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: this.#key(endpointId, MANIFEST_FILE) }));
      return head.ETag;
    } catch (error) {
      if (statusOf(error) === HTTP_NOT_FOUND) return undefined;
      throw error;
    }
  }

  async prepareWork(endpointId: string): Promise<CrystalWork> {
    const parent = join(this.#workRoot, endpointId);
    await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(join(parent, 'work-'));
    const manifest = await this.#get(this.#key(endpointId, MANIFEST_FILE));
    if (!manifest) return { dir, stored: [] };
    const { entries } = parseManifest(manifest.text);
    await writeFile(join(dir, MANIFEST_FILE), manifest.text);
    await Promise.all(
      Object.keys(entries).map(async (key) => {
        const module = await this.#get(this.#key(endpointId, moduleFileFor(key)));
        if (module) await writeFile(join(dir, moduleFileFor(key)), module.text);
      }),
    );
    return { dir, etag: manifest.etag, stored: Object.keys(entries) };
  }

  async publish(endpointId: string, work: CrystalWork): Promise<string | undefined> {
    const { entries } = await readManifest(work.dir);
    const stored = new Set(work.stored);
    // Modules first: a manifest must never name a module that is not there yet.
    for (const key of Object.keys(entries).filter((k) => !stored.has(k))) {
      const file = moduleFileFor(key);
      await this.#put(this.#key(endpointId, file), await readFile(join(work.dir, file), 'utf8'), 'text/javascript');
    }
    // Conditional on the version the work started from, so two Crystallize calls cannot overwrite each other.
    const condition = work.etag ? { IfMatch: work.etag } : { IfNoneMatch: '*' };
    try {
      const put = await this.#put(this.#key(endpointId, MANIFEST_FILE), await readFile(join(work.dir, MANIFEST_FILE), 'utf8'), 'application/json', condition);
      return put.ETag;
    } catch (error) {
      const status = statusOf(error);
      // 409: S3 refuses one of two conditional writes that race on the same key.
      if (status === HTTP_PRECONDITION_FAILED || status === HTTP_CONFLICT) throw new CrystallizeConflictError();
      throw error;
    }
  }

  async discardWork(work: CrystalWork): Promise<void> {
    await rm(work.dir, { recursive: true, force: true });
  }

  #key(endpointId: string, file: string): string {
    return `endpoints/${endpointId}/crystal/${file}`;
  }

  async #get(key: string): Promise<{ text: string; etag?: string } | undefined> {
    try {
      const object = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      return { text: await object.Body.transformToString('utf-8'), etag: object.ETag };
    } catch (error) {
      if (statusOf(error) === HTTP_NOT_FOUND) return undefined;
      throw error;
    }
  }

  #put(key: string, body: string, contentType: string, condition: { IfMatch?: string; IfNoneMatch?: string } = {}): Promise<{ ETag?: string }> {
    return this.#client.send(new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: body, ContentType: contentType, ...condition }));
  }
}

/**
 * The local endpoint's Crystal folder: Crystallize writes straight into it, and the
 * runner restarts the process to load it, so publish and discard have nothing to do.
 */
export class DirCrystalStore implements CrystalStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = resolve(dir);
  }

  async load(): Promise<CrystalLoad> {
    const index = join(this.#dir, 'index.mjs');
    if (!(await exists(index))) return { registry: {}, warnings: [] };
    const { crystals } = (await import(pathToFileURL(index).href)) as { crystals: CrystalRegistry };
    return { registry: crystals, warnings: [] };
  }

  async version(): Promise<string | undefined> {
    const info = await stat(join(this.#dir, MANIFEST_FILE)).catch(() => undefined);
    return info ? String(info.mtimeMs) : undefined;
  }

  async prepareWork(): Promise<CrystalWork> {
    return { dir: this.#dir, stored: [] };
  }

  async publish(): Promise<string | undefined> {
    return this.version();
  }

  async discardWork(): Promise<void> {}
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

/** The HTTP status of an AWS SDK error, if it has one. */
function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}
