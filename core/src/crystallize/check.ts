// `slime-crystal check`: the app's CI re-checks the Crystal folder, because core
// doesn't re-check Crystal at startup (C10).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertReadOnlySql } from '../engine/checks/sql.js';
import { INDEX_FILE, INDEX_TYPES_FILE, MODULE_EXTENSION, readManifest, renderIndex, renderIndexTypes, type Manifest } from './manifest.js';
import { sha256 } from '../shared/hash.js';
import { parseModule } from './module-format.js';

const REGENERATE = 'run crystallize again instead of editing it';

/** Every problem in the folder; empty means it passes. */
export async function checkCrystalFolder(dir: string): Promise<string[]> {
  let manifest: Manifest;
  try {
    manifest = await readManifest(dir);
  } catch (error) {
    return [`manifest.json: ${(error as Error).message}`];
  }
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(manifest.entries)) {
    const problem = await moduleProblem(dir, entry.file, entry.sha256);
    if (problem) problems.push(`${key}: ${problem}`);
  }
  problems.push(...(await generatedFileProblems(dir, manifest)));
  problems.push(...(await unlistedModules(dir, manifest)));
  return problems;
}

async function moduleProblem(dir: string, file: string, pinnedSha256: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(dir, file), 'utf8');
    if (sha256(text) !== pinnedSha256) return `${file} does not match the hash pinned in manifest.json; ${REGENERATE}`;
    // A re-pinned hand edit still has to pass the allowlist and the read-only lint.
    assertReadOnlySql(parseModule(text).sql);
    return undefined;
  } catch (error) {
    return `${file}: ${(error as Error).message}`;
  }
}

async function generatedFileProblems(dir: string, manifest: Manifest): Promise<string[]> {
  const expected = [
    { file: INDEX_FILE, text: renderIndex(manifest) },
    { file: INDEX_TYPES_FILE, text: renderIndexTypes() },
  ];
  // A folder nothing was crystallized into yet has no generated files, and that's fine.
  const isEmpty = Object.keys(manifest.entries).length === 0;
  const problems: string[] = [];
  for (const { file, text } of expected) {
    const actual = await readFile(join(dir, file), 'utf8').catch(() => undefined);
    if (actual === undefined && isEmpty) continue;
    if (actual !== text) problems.push(`${file} does not match manifest.json; ${REGENERATE}`);
  }
  return problems;
}

async function unlistedModules(dir: string, manifest: Manifest): Promise<string[]> {
  const listed = new Set([INDEX_FILE, ...Object.values(manifest.entries).map(({ file }) => file)]);
  const files = await readdir(dir).catch(() => []);
  return files.filter((file) => file.endsWith(MODULE_EXTENSION) && !listed.has(file)).map((file) => `${file} is not in manifest.json`);
}
