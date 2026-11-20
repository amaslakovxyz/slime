// Checks what `npm pack` would ship, without writing a tarball: the compiled
// entry and its types must be there, and sources, tests and configs must not.
// Run after `npm run build` (CI does), or rely on `prepack`.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const [report] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkgDir, encoding: 'utf8' }),
);
const files = report.files.map((f) => f.path).sort();

const required = ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts'];
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
