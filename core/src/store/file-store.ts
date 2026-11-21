// One JSON file per key: <dir>/<ns>/<key>.json (§4.7).
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SlimeStore, StoreEntry } from './types.js';

export const DEFAULT_STORE_DIR = './.slime';

const FILE_EXTENSION = '.json';
const TEMPORARY_EXTENSION = '.tmp';
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function fileStore(dir: string = DEFAULT_STORE_DIR): SlimeStore {
  const namespaceDir = (ns: string): string => join(dir, safeName(ns));
  const pathOf = (ns: string, key: string): string => join(namespaceDir(ns), `${safeName(key)}${FILE_EXTENSION}`);

  return {
    async get(ns, key) {
      const json = await readIfExists(pathOf(ns, key));
      return json === undefined ? undefined : JSON.parse(json);
    },
    async put(ns, key, value) {
      const target = pathOf(ns, key);
      await mkdir(dirname(target), { recursive: true });
      // Write, then rename: a crash never leaves half a file.
      const temporary = `${target}.${randomUUID()}${TEMPORARY_EXTENSION}`;
      await writeFile(temporary, JSON.stringify(value));
      await rename(temporary, target);
    },
    async list(ns, prefix = ''): Promise<StoreEntry[]> {
      const keys = (await fileNamesIn(namespaceDir(ns)))
        .filter((fileName) => fileName.endsWith(FILE_EXTENSION))
        .map((fileName) => fileName.slice(0, -FILE_EXTENSION.length))
        .filter((key) => key.startsWith(prefix));
      const values = await Promise.all(keys.map((key) => readIfExists(pathOf(ns, key))));
      return keys.flatMap((key, index) => {
        const json = values[index];
        return json === undefined ? [] : [{ key, value: JSON.parse(json) }];
      });
    },
    async delete(ns, key) {
      await rm(pathOf(ns, key), { force: true });
    },
  };
}

// Keys become file names, so path separators and ".." are refused.
function safeName(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`file store: "${name}" is not a safe file name`);
  return name;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function fileNamesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
