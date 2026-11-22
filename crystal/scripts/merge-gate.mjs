#!/usr/bin/env node
// Whether an agent-written Crystal PR may merge without a person. All of:
//   - every file the branch changes since <base> is inside the Crystal folder;
//   - the agent loop's report: the last round passed verify, every reviewer approved;
//   - `slime-crystal verify` passes again here, on the committed folder.
// Anything else leaves the PR for a person. Exit 0: may merge; 1: may not (reasons printed).
//
//   node crystal/scripts/merge-gate.mjs --report <file> --dir <crystal folder> --base <ref> --database-url <url>
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { postgresConnector } from '@slime-cloud/core/postgres';
import { verifyCrystalFolder } from '@slime-cloud/crystal';

const run = promisify(execFile);
const { values: args } = parseArgs({ options: { report: { type: 'string' }, dir: { type: 'string' }, base: { type: 'string' }, 'database-url': { type: 'string' } } });
if (!args.report || !args.dir || !args.base || !args['database-url']) {
  console.error('usage: merge-gate.mjs --report <file> --dir <crystal folder> --base <ref> --database-url <url>');
  process.exit(2);
}

const reasons = [...(await changedOutsideFolder()), ...(await reportProblems()), ...(await verifyProblems())];
if (reasons.length > 0) {
  console.log(`merge gate: a person must review this PR:\n  ${reasons.join('\n  ')}`);
  process.exit(1);
}
console.log('merge gate: may merge (only the Crystal folder changed, verify passed, every reviewer approved)');

async function changedOutsideFolder() {
  const { stdout: root } = await run('git', ['rev-parse', '--show-toplevel']);
  const folder = relative(root.trim(), resolve(args.dir));
  const { stdout } = await run('git', ['diff', '--name-only', `${args.base}...HEAD`]);
  const outside = stdout.split('\n').filter((file) => file && !file.startsWith(`${folder}/`));
  return outside.map((file) => `changes ${file}, outside ${folder}/`);
}

async function reportProblems() {
  const report = JSON.parse(await readFile(args.report, 'utf8'));
  const last = report.rounds.at(-1);
  const problems = [];
  if (!report.approved) problems.push('not every reviewer approved');
  if (last && !last.gate.verified) problems.push(`the last round failed verify: ${last.gate.problems.join('; ')}`);
  return problems;
}

async function verifyProblems() {
  const connector = postgresConnector({ url: args['database-url'] });
  try {
    return (await verifyCrystalFolder(args.dir, { connector })).map((problem) => `verify: ${problem}`);
  } finally {
    await connector.close();
  }
}
