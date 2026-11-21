import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertReadOnlySql } from '../engine/checks/sql.js';
import { sha256 } from '../shared/hash.js';
import { parseModule, type CrystalCode } from './module-format.js';

interface ModuleExports {
  sql?: unknown;
  params?: unknown;
  shape?: unknown;
}

const IMPORT_DIR = join(tmpdir(), 'slime-crystal');

/**
 * Checks a module's text, then imports exactly those bytes, as an app that imports
 * `index.mjs` will: a module that fails the allowlist or the read-only lint never
 * loads, and one whose exports differ from its parsed source is refused. Importing
 * runs no shape code (the module only declares it). The temporary copy is named by
 * its hash, so a changed module never hits Node's import cache.
 */
export async function importCheckedModule(text: string): Promise<CrystalCode> {
  const code = parseModule(text);
  assertReadOnlySql(code.sql);
  await mkdir(IMPORT_DIR, { recursive: true });
  const file = join(IMPORT_DIR, `${sha256(text)}.mjs`);
  await writeFile(file, text);
  try {
    const exports = (await import(pathToFileURL(file).href)) as ModuleExports;
    assertExportsMatch(exports, code);
    return code;
  } finally {
    await rm(file, { force: true });
  }
}

function assertExportsMatch(exports: ModuleExports, code: CrystalCode): void {
  if (exports.sql !== code.sql || JSON.stringify(exports.params) !== JSON.stringify(code.params)) {
    throw new Error('module exports do not match its source');
  }
  const hasShapeFunction = typeof exports.shape === 'function';
  if (code.shape ? !hasShapeFunction : exports.shape !== null) throw new Error('module `shape` export is wrong');
}
