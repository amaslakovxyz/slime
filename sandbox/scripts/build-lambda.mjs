// Bundles the runtime for AWS Lambda into dist/lambda/ (zipped by Terraform,
// infra/aws/platform/runtime.tf). Output must be deterministic: the same source
// gives the same zip hash, so Terraform plans show no change for no change.
//
//   index.mjs              src/lambda.ts and everything it imports
//   shape-worker.mjs       the sandbox worker (sandbox.ts loads it by URL, same dir)
//   emscripten-module.wasm QuickJS release-sync build, found by URL next to the worker
//   offline/handlers.json  canned handlers for SLIME_PROVIDER=offline (read from cwd)
//   crystal/               Crystal folder, if the repo has one
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/lambda');
const require = createRequire(import.meta.url);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/lambda.ts', 'shape-worker': 'src/shape-worker.mjs' },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // pg's optional native binding is never used.
  external: ['pg-native'],
  // CommonJS dependencies (pg, the AWS SDK) call require(); give ESM one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

const wasm = join(dirname(require.resolve('@jitl/quickjs-wasmfile-release-sync')), 'emscripten-module.wasm');
cpSync(wasm, join(out, 'emscripten-module.wasm'));
cpSync(join(root, 'offline'), join(out, 'offline'), { recursive: true });
if (existsSync(join(root, 'crystal'))) cpSync(join(root, 'crystal'), join(out, 'crystal'), { recursive: true });

console.log(`built ${out}`);
