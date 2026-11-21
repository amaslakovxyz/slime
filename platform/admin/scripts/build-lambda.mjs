// `npm run build:lambda`: builds the admin for the slime-admin Lambda.
//   1. ADMIN_SOURCE_HASH = SHA-256 over every input file of platform/admin, plus the
//      build-time ADMIN_ORIGIN and the Node major version.
//   2. `next build` with it, so the build id follows the inputs (next.config.ts).
//   3. dist/lambda/ = the standalone server + .next/static + public + lambda/*
//      (run.sh, start.mjs), copied in sorted order.
//   4. dist/source-hash.txt = the hash, base64: Terraform's source_code_hash.
// Next writes per-build random values (server-action keys, preview secrets), so the
// zip itself is never reproducible; the hash of the inputs is the deploy trigger, and
// a rebuild with unchanged inputs leaves the function untouched.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const out = join(dist, 'lambda');
const adminOrigin = process.env.ADMIN_ORIGIN || 'admin.amaslakov.com';
const nodeMajor = process.versions.node.split('.')[0];
/** Lambda caps the unzipped function plus layers at 250 MB; the Web Adapter layer needs a little. */
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

/** Outputs, local state and installed packages: not inputs (package-lock.json is). */
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'dist', '.data', 'test-results', 'playwright-report']);
/**
 * Secrets, plus files `next build`, `next dev` and `tsc` generate (all git-ignored): hashing them
 * would make the first build after a clean checkout differ from the second.
 */
const skippedFile = (name) =>
  name.startsWith('.env') || name === 'next-env.d.ts' || name.endsWith('.tsbuildinfo') || name === '.DS_Store';

/** Relative paths of every input file, sorted, with `/` separators on every OS. */
function inputFiles(dir, top = true) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      if (!(top && SKIPPED_DIRS.has(name))) files.push(...inputFiles(path, false));
    } else if (!skippedFile(name)) {
      files.push(relative(root, path).split(sep).join('/'));
    }
  }
  return files;
}

function sourceHash() {
  const hash = createHash('sha256');
  for (const file of inputFiles(root)) {
    const path = join(root, file);
    const stat = lstatSync(path);
    hash.update(`${file}\0`);
    hash.update(stat.isSymbolicLink() ? `-> ${readlinkSync(path)}` : readFileSync(path));
    hash.update('\0');
  }
  hash.update(`ADMIN_ORIGIN=${adminOrigin}\0node=${nodeMajor}\0`);
  return hash.digest();
}

/**
 * Copies a tree in sorted order. Symlinks are copied as their targets (Lambda zips carry plain
 * files), and nothing secret or local goes in even if Next traced it.
 */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.env') || name === '.data') continue;
    const source = join(from, name);
    const target = join(to, name);
    const stat = statSync(source);
    if (stat.isDirectory()) copyTree(source, target);
    else {
      copyFileSync(source, target);
      chmodSync(target, stat.mode & 0o777);
    }
  }
}

function treeBytes(dir) {
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    bytes += stat.isDirectory() ? treeBytes(path) : stat.size;
  }
  return bytes;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const digest = sourceHash();
// Hex for the build id (it becomes a URL path segment); base64 for Terraform.
const buildId = digest.toString('hex');
console.log(`ADMIN_SOURCE_HASH ${buildId} (ADMIN_ORIGIN=${adminOrigin}, node ${nodeMajor})`);

const build = spawnSync('npx', ['--no-install', 'next', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ADMIN_SOURCE_HASH: buildId, ADMIN_ORIGIN: adminOrigin, NEXT_TELEMETRY_DISABLED: '1' },
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const standalone = join(root, '.next/standalone');
if (!existsSync(join(standalone, 'server.js'))) throw new Error('next build wrote no .next/standalone/server.js');
rmSync(out, { recursive: true, force: true });
copyTree(standalone, out);
copyTree(join(root, '.next/static'), join(out, '.next/static'));
if (existsSync(join(root, 'public'))) copyTree(join(root, 'public'), join(out, 'public'));
copyTree(join(root, 'lambda'), out);
// start.mjs imports the SSM client before server.js; it must be among the traced packages.
if (!existsSync(join(out, 'node_modules/@aws-sdk/client-ssm/package.json'))) {
  throw new Error('dist/lambda has no node_modules/@aws-sdk/client-ssm (needed by start.mjs)');
}

const bytes = treeBytes(out);
console.log(`dist/lambda: ${mb(bytes)} unzipped`);
if (bytes > MAX_UNZIPPED_BYTES) {
  console.error(`dist/lambda is above ${mb(MAX_UNZIPPED_BYTES)}; Lambda allows 250 MB with layers.`);
  process.exit(1);
}

// The zip Terraform uploads directly must stay under 50 MB; measured on a throwaway copy.
const zipDir = mkdtempSync(join(tmpdir(), 'slime-admin-zip-'));
const zip = spawnSync('zip', ['-qrX', join(zipDir, 'lambda.zip'), '.'], { cwd: out, stdio: 'ignore' });
if (zip.status === 0) console.log(`dist/lambda: ${mb(statSync(join(zipDir, 'lambda.zip')).size)} zipped`);
else console.log('zip is not installed; zipped size not measured');
rmSync(zipDir, { recursive: true, force: true });

writeFileSync(join(dist, 'source-hash.txt'), `${digest.toString('base64')}\n`);
console.log(`dist/source-hash.txt ${digest.toString('base64')}`);
