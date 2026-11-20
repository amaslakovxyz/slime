// npm run crystallize -- [--dry-run] [--optimizer claude|groq|none] [--min-runs N] [--commit] [--push]
//
// Turns proven Liquid handlers (saved in slime_meta) into Crystal modules in the
// Crystal folder. With --commit it commits them on the current branch; with
// --push it also pushes that branch. It never commits on main: AGENTS.md routes
// every change through a pull request.
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { config } from './config.js';
import { PostgresConnector } from './connectors/postgres.js';
import { crystallize } from './crystal/crystallize.js';
import { createOptimizer } from './crystal/optimizers.js';
import { schemaHashOf } from './fingerprint.js';
import { promptHashFor } from './prompts.js';
import { PostgresHandlerStore } from './store.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const minRunsArg = args.indexOf('--min-runs');
const minRuns = minRunsArg >= 0 ? Number(args[minRunsArg + 1]) : config.crystalMinRuns;
const dryRun = flag('--dry-run');

function die(message: string): never {
  console.error(message);
  process.exit(1);
}
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' });

if (!config.metaDatabaseUrl) die('META_DATABASE_URL is empty: Crystal is built from saved Liquid handlers.');
if (!Number.isInteger(minRuns) || minRuns < 1) die('--min-runs must be a positive integer');

// Check git before spending model calls on candidates that can't be committed.
let branch = '';
if (flag('--commit') && !dryRun) {
  branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  if (['main', 'master', 'HEAD'].includes(branch)) {
    die(`Refusing to commit Crystal on "${branch}": AGENTS.md requires a branch and a pull request. Switch to a branch (e.g. chore/crystal-${new Date().toISOString().slice(0, 10)}) and rerun.`);
  }
}

const connector = new PostgresConnector(config.databaseUrl);
const safety = await connector.safetyCheck();
if (!safety.ok) die(`The database user is not read-only:\n - ${safety.problems.join('\n - ')}`);
const schemaHash = schemaHashOf(await connector.describe());
const store = new PostgresHandlerStore(config.metaDatabaseUrl, config.metaTable);
await store.init();

const optimizerArg = args.indexOf('--optimizer');
const optimizer = createOptimizer(optimizerArg >= 0 ? args[optimizerArg + 1] : undefined);
console.log(
  `crystal dir: ${relative(process.cwd(), config.crystalDir) || '.'}  min runs: ${minRuns}  ` +
    `optimizer: ${optimizer ? optimizer.model : 'none (Liquid code moved as-is)'}${dryRun ? '  (dry run: nothing written)' : ''}\n`,
);

const reports = await crystallize({
  connector,
  store,
  dir: config.crystalDir,
  schemaHash,
  scope: { schemaHash, promptHash: promptHashFor(config.provider), model: config.model },
  minRuns,
  optimizer,
  dryRun,
});

console.table(
  reports.map((r) => ({
    intent: r.intent.length > 60 ? `${r.intent.slice(0, 57)}...` : r.intent,
    outcome: r.outcome,
    optimized: r.optimized ?? '',
    file: r.file ?? '',
  })),
);
for (const r of reports.filter((x) => x.reasons.length)) console.log(`\n${r.intent}\n  - ${r.reasons.join('\n  - ')}`);

const created = reports.filter((r) => r.outcome === 'crystallized');
if (created.length && flag('--commit') && !dryRun) {
  git('add', config.crystalDir);
  // Normal commit: pre-commit hooks run (AGENTS.md: never --no-verify).
  git(
    'commit',
    '-m',
    `Crystallize ${created.length} handler${created.length > 1 ? 's' : ''}\n\n` +
      created.map((r) => `- ${r.intent}${r.optimized ? ' (optimized)' : ''}`).join('\n'),
  );
  console.log(`\nCommitted on ${branch}.`);
  if (flag('--push')) {
    git('push', '-u', 'origin', branch);
    console.log(`Pushed ${branch}. Open a pull request to bring the Crystal into main.`);
  }
}

await store.close();
await connector.close();
process.exit(0);
