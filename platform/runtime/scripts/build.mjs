// Bundles the runtime for AWS Lambda into dist/lambda/ (zipped by Terraform,
// platform/infra/platform/runtime.tf). @slime-cloud/core comes from its built dist/
// (build it first: npm run build -w @slime-cloud/core). Output must be
// deterministic: the same source gives the same zip hash, so Terraform plans
// show no change for no change.
//
//   index.js               src/lambda.ts, the core and every dependency
//   shape-worker.js        the core's shaping worker; the core resolves it as ./shape-worker.js
//   emscripten-module.wasm QuickJS release-sync build, found by URL next to the worker
//   package.json           { "type": "module" }, so both .js files load as ES modules
//   offline/handlers.json  canned handlers for SLIME_PROVIDER=offline (read from cwd)
//
// Crystals are not bundled: each endpoint's live in S3 (src/crystal-store.ts).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/lambda');
const runtimeRequire = createRequire(join(root, 'package.json'));
const coreRoot = dirname(runtimeRequire.resolve('@slime-cloud/core/package.json'));
const worker = resolveShapeWorker();
// QuickJS's wasm resolves from the core's own dependencies.
const coreRequire = createRequire(join(coreRoot, 'package.json'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/lambda.ts', 'shape-worker': worker },
  outdir: out,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // pg's optional native binding is never used.
  external: ['pg-native'],
  // CommonJS dependencies (pg, the AWS SDK clients for SSM, S3 and DynamoDB) call require(); give ESM one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

writeFileSync(join(out, 'package.json'), '{ "type": "module" }\n');
const wasm = join(dirname(coreRequire.resolve('@jitl/quickjs-wasmfile-release-sync')), 'emscripten-module.wasm');
cpSync(wasm, join(out, 'emscripten-module.wasm'));
cpSync(join(root, 'offline'), join(out, 'offline'), { recursive: true });

console.log(`built ${out}`);

// The core exports the worker's path, so its folder layout can change freely.
function resolveShapeWorker() {
  try {
    return runtimeRequire.resolve('@slime-cloud/core/shape-worker');
  } catch {
    throw new Error("@slime-cloud/core's shape worker is missing: build the core first (npm run build -w @slime-cloud/core)");
  }
}
