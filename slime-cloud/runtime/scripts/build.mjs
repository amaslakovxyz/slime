// Bundles the runtime for AWS Lambda into dist/lambda/ (zipped by Terraform,
// infra/aws/platform/runtime.tf). @slime-cloud/core is compiled from sandbox/src
// through the tsconfig `paths` mapping, which esbuild applies itself. Output must be deterministic: the same source
// gives the same zip hash, so Terraform plans show no change for no change.
//
//   index.mjs              src/lambda.ts, the core and every dependency
//   shape-worker.mjs       the core's sandbox worker (sandbox.ts loads it by URL, same dir)
//   emscripten-module.wasm QuickJS release-sync build, found by URL next to the worker
//   offline/handlers.json  canned handlers for SLIME_PROVIDER=offline (read from cwd)
//   crystal/               Crystal folder, if the repo has one
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = join(root, '../../sandbox'); // keep in sync with tsconfig.json `paths`
const out = join(root, 'dist/lambda');
// Core assets resolve from the core's own node_modules (npm ci in sandbox/).
const coreRequire = createRequire(join(core, 'package.json'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/lambda.ts', 'shape-worker': join(core, 'src/shape-worker.mjs') },
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

const wasm = join(dirname(coreRequire.resolve('@jitl/quickjs-wasmfile-release-sync')), 'emscripten-module.wasm');
cpSync(wasm, join(out, 'emscripten-module.wasm'));
cpSync(join(core, 'offline'), join(out, 'offline'), { recursive: true });
if (existsSync(join(core, 'crystal'))) cpSync(join(core, 'crystal'), join(out, 'crystal'), { recursive: true });

console.log(`built ${out}`);
