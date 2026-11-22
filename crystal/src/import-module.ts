import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isStepsCode, parseModule, sqlStatementsOf, type CrystalCode } from './module-format.js';
import { assertReadOnlySql, canonicalJSON, sha256 } from '@slime-cloud/core/tooling';

interface ModuleExports {
  steps?: unknown;
  sql?: unknown;
  params?: unknown;
  shape?: unknown;
}

const IMPORT_PREFIX = join(tmpdir(), 'slime-crystal-');

/**
 * Checks a module's text, then imports exactly those bytes, as an app that imports
 * `index.mjs` will: a module that fails the allowlist or the read-only lint never
 * loads, and one whose exports differ from its parsed source is refused. Importing
 * runs no shape code (the module only declares it). Each import gets its own
 * temporary folder: a fresh URL never hits Node's import cache, and two jobs
 * importing the same module at once can't delete each other's copy.
 */
export async function importCheckedModule(text: string): Promise<CrystalCode> {
  const code = parseModule(text);
  for (const { sql } of sqlStatementsOf(code)) assertReadOnlySql(sql);
  const dir = await mkdtemp(IMPORT_PREFIX);
  const file = join(dir, `${sha256(text)}.mjs`);
  await writeFile(file, text);
  try {
    const exports = (await import(pathToFileURL(file).href)) as ModuleExports;
    assertExportsMatch(exports, code);
    return code;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function assertExportsMatch(exports: ModuleExports, code: CrystalCode): void {
  const isSame = isStepsCode(code)
    ? canonicalJSON(exports.steps) === canonicalJSON(code.steps)
    : exports.sql === code.sql && JSON.stringify(exports.params) === JSON.stringify(code.params);
  if (!isSame) throw new Error('module exports do not match its source');
  const hasShapeFunction = typeof exports.shape === 'function';
  if (code.shape ? !hasShapeFunction : exports.shape !== null) throw new Error('module `shape` export is wrong');
}
