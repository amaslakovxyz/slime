// Reads the Crystal folder: manifest.json plus one module per crystallized handler.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Shape } from '../shape.js';
import { assertReadOnlySql } from '../sql-guard.js';
import { parseModule, type CrystalCode } from './module.js';

export interface ManifestEntry {
  file: string;
  sha256: string;
  fixtures: string;
  fingerprint: string;
  schemaHash: string;
  intent: string;
  inputSig: Record<string, string>;
  output: Shape;
  optimized: boolean;
  notes: string[];
  from: { artifactKey: string; model: string; promptHash: string; revision: number };
  createdAt: string;
}

export interface Manifest {
  version: 1;
  entries: Record<string, ManifestEntry>;
}

export type ShapeFn = (rows: Record<string, unknown>[], input: Record<string, unknown>) => unknown;

export interface LoadedCrystal {
  key: string;
  entry: ManifestEntry;
  code: CrystalCode;
  shape: ShapeFn | null;
}

export const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

export function readManifest(dir: string): Manifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return { version: 1, entries: {} };
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  if (manifest.version !== 1) throw new Error(`${path}: unsupported manifest version ${manifest.version}`);
  return manifest;
}

/** Stable output (sorted keys, trailing newline) so diffs stay small and hooks don't rewrite it. */
export function writeManifest(dir: string, manifest: Manifest): void {
  mkdirSync(dir, { recursive: true });
  const entries = Object.fromEntries(Object.keys(manifest.entries).sort().map((k) => [k, manifest.entries[k]]));
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
}

/**
 * Checks a module's text and imports it. The text is checked before import, so
 * a module that fails the allowlist never runs.
 */
export async function importModuleText(text: string): Promise<{ code: CrystalCode; shape: ShapeFn | null }> {
  const code = parseModule(text);
  assertReadOnlySql(code.sql);
  // Imported from a temp copy named by its hash: the exact checked bytes are what
  // runs, and a changed module never hits Node's import cache under an old name.
  const dir = join(tmpdir(), 'slime-crystal');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sha256Hex(text)}.mjs`);
  writeFileSync(file, text);
  try {
    const mod = await import(pathToFileURL(file).href);
    if (mod.sql !== code.sql || JSON.stringify(mod.params) !== JSON.stringify(code.params)) {
      throw new Error('module exports do not match its source');
    }
    if (code.shape ? typeof mod.shape !== 'function' : mod.shape !== null) throw new Error('module `shape` export is wrong');
    return { code, shape: mod.shape };
  } finally {
    rmSync(file, { force: true });
  }
}

/** Loads every Crystal entry for the current schema. Never throws for a bad entry: it is refused and reported. */
export async function loadCrystals(
  dir: string,
  schemaHash: string,
): Promise<{ loaded: LoadedCrystal[]; refused: { key: string; reason: string }[]; ignored: number }> {
  const loaded: LoadedCrystal[] = [];
  const refused: { key: string; reason: string }[] = [];
  let ignored = 0;
  let manifest: Manifest;
  try {
    manifest = readManifest(dir);
  } catch (err) {
    return { loaded, refused: [{ key: 'manifest.json', reason: (err as Error).message }], ignored };
  }
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (entry.schemaHash !== schemaHash) {
      ignored++; // generated against another schema; `crystallize` will rebuild it from Liquid
      continue;
    }
    try {
      const text = readFileSync(join(dir, entry.file), 'utf8');
      if (sha256Hex(text) !== entry.sha256) throw new Error(`${entry.file} does not match the hash pinned in manifest.json`);
      const { code, shape } = await importModuleText(text);
      loaded.push({ key, entry, code, shape });
    } catch (err) {
      refused.push({ key, reason: (err as Error).message });
    }
  }
  return { loaded, refused, ignored };
}
