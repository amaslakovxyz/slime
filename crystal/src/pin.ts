// `slime-crystal pin`: after a module was edited (by a person or an agent), re-checks
// each changed module, pins its new hash and re-renders the generated files. It never
// re-pins a cases file: the reference stays the one crystallize wrote, so
// `slime-crystal verify` still compares the edit with the original Liquid handler.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readManifest, writeManifestAndIndex } from './manifest.js';
import { parseModule, sqlStatementsOf } from './module-format.js';
import { assertReadOnlySql, sha256 } from '@slime-cloud/core/tooling';

/** The keys whose module it re-pinned; throws, pinning nothing, when a changed module fails a check. */
export async function pinCrystalFolder(dir: string): Promise<string[]> {
  const manifest = await readManifest(dir);
  const changed: { key: string; hash: string }[] = [];
  for (const [key, entry] of Object.entries(manifest.entries)) {
    const text = await readFile(join(dir, entry.file), 'utf8');
    const hash = sha256(text);
    if (hash === entry.sha256) continue;
    try {
      for (const { sql } of sqlStatementsOf(parseModule(text))) assertReadOnlySql(sql);
    } catch (error) {
      throw new Error(`${entry.file}: ${(error as Error).message}`);
    }
    changed.push({ key, hash });
  }
  if (changed.length === 0) return [];
  for (const { key, hash } of changed) Object.assign(manifest.entries[key]!, { sha256: hash, isOptimized: true });
  await writeManifestAndIndex(dir, manifest);
  return changed.map(({ key }) => key);
}
