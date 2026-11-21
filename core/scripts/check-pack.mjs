// Checks what `npm pack` would ship, without writing a tarball: the compiled
// entry and its types must be there, and sources, tests and configs must not.
// Run after `npm run build` (CI does), or rely on `prepack`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const [report] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkgDir, encoding: 'utf8' }),
);
const files = report.files.map((f) => f.path).sort();

// Every file package.json points at (exports and bin) must ship, so a new
// subpath can't be forgotten here.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const exportTargets = Object.values(pkg.exports).flatMap((target) => (typeof target === 'string' ? [target] : Object.values(target)));
const required = [...new Set([...exportTargets, ...Object.values(pkg.bin ?? {}), 'README.md'])]
  .map((path) => path.replace(/^\.\//, ''))
  .sort();
const forbidden = [/^src\//, /^test\//, /^scripts\//, /^tsconfig/, /^PLAN\.md$/, /^docs\//];

const problems = [
  ...required.filter((f) => !files.includes(f)).map((f) => `missing ${f}`),
  ...files.filter((f) => forbidden.some((re) => re.test(f))).map((f) => `should not ship ${f}`),
];

if (problems.length) {
  console.error(`npm pack check failed:\n  ${problems.join('\n  ')}\nPacked files:\n  ${files.join('\n  ')}`);
  process.exit(1);
}
console.log(`npm pack check passed: ${report.name}@${report.version}, ${files.length} files, ${report.size} bytes`);
