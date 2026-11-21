// Bundles the provisioner for AWS Lambda into dist/lambda/index.mjs (zipped by
// Terraform, platform/infra/platform/provisioner.tf). Output must be deterministic:
// the same source gives the same zip hash, so Terraform plans show no change for
// no change. The endpoint shim (shim/index.mjs) is zipped by Terraform as is.
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/lambda');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/handler.ts' },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // CommonJS dependencies (the AWS SDK) call require(); give ESM one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

console.log(`built ${out}`);
