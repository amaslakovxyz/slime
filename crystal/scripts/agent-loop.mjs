#!/usr/bin/env node
// The Crystal agent loop. A writer agent optimizes freshly crystallized modules; the
// deterministic gate (pin + verify) decides whether its edit stays; reviewer agents
// then read the result, and their notes go back to the writer, for a few rounds.
// Prints a JSON report. Merging is merge-gate.mjs's call, on this report and the diff.
//
//   node crystal/scripts/agent-loop.mjs --dir <crystal folder> --database-url <read-only url>
//     [--keys k1,k2] [--rounds 2] [--report <file>] [--cli "node crystal/dist/bin.js"]
//     [--writer-model <model>] [--reviewer-model <model>] [--max-budget-usd <n>]
//
// Needs the `claude` CLI and a built @slime-cloud/crystal. With ANTHROPIC_API_KEY set it
// runs --bare (CI); otherwise it uses the local login, without MCP servers or skills.
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { postgresConnector } from '@slime-cloud/core/postgres';
import { moduleFileFor, parseCases, pinCrystalFolder, readManifest, verifyCrystalFolder } from '@slime-cloud/crystal';

const run = promisify(execFile);
const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents');
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REVIEWERS = ['reviewer-correctness', 'reviewer-security', 'reviewer-performance'];
const VERDICT_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['approve', 'reject'] }, problems: { type: 'array', items: { type: 'string' } } },
  required: ['verdict', 'problems'],
  additionalProperties: false,
};
const AGENT_TIMEOUT_MS = 20 * 60 * 1000;
const KEY_PREFIX = 12;

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string' },
    'database-url': { type: 'string' },
    keys: { type: 'string' },
    rounds: { type: 'string', default: '2' },
    report: { type: 'string' },
    // This repository's build; an app passes "npx slime-crystal".
    cli: { type: 'string', default: 'node crystal/dist/bin.js' },
    'writer-model': { type: 'string', default: 'claude-opus-5-5' },
    'reviewer-model': { type: 'string', default: 'claude-sonnet-5-5' },
    'max-budget-usd': { type: 'string', default: '10' },
  },
});
if (!args.dir || !args['database-url']) {
  console.error('usage: agent-loop.mjs --dir <crystal folder> --database-url <read-only url> [--keys k1,k2] [--rounds 2] [--report file]');
  process.exit(2);
}
const dir = resolve(args.dir);
const databaseUrl = args['database-url'];
let costUsd = 0;

const report = await main();
const text = `${JSON.stringify(report, null, 2)}\n`;
if (args.report) await writeFile(args.report, text);
process.stdout.write(text);

async function main() {
  const manifest = await readManifest(dir);
  const keys = args.keys ? args.keys.split(',').filter(Boolean) : Object.keys(manifest.entries).filter((key) => manifest.entries[key].isOptimized !== true);
  if (keys.length === 0) return { keys, rounds: [], optimized: [], approved: true, costUsd, note: 'nothing to optimize' };
  const snapshot = await mkdtemp(join(tmpdir(), 'crystal-agent-snapshot-'));
  await cp(dir, snapshot, { recursive: true });
  const rounds = [];
  let feedback = '';
  let approved = false;
  try {
    for (let round = 1; round <= Number(args.rounds) && !approved; round++) {
      const writer = await runWriter(keys, feedback);
      const gate = await keepOnlyVerifiedModules(keys, snapshot);
      const reviews = await runReviewers(keys);
      approved = reviews.every(({ verdict }) => verdict === 'approve');
      rounds.push({ round, writer, gate, reviews });
      feedback = feedbackFor(gate, reviews);
    }
    return { keys, rounds, optimized: await changedModules(keys, snapshot), approved, costUsd: round2(costUsd) };
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

async function runWriter(keys, feedback) {
  const prompt = (await readFile(join(AGENTS_DIR, 'writer.md'), 'utf8'))
    .replaceAll('{{DIR}}', dir)
    .replaceAll('{{KEYS}}', keys.map((key) => `\`${key}\``).join(', '))
    .replaceAll('{{CLI}}', args.cli)
    // Written out, not $VAR: a command with an expansion never matches the allowed prefix. A read-only role.
    .replaceAll('{{DATABASE_URL}}', databaseUrl)
    .replaceAll('{{FEEDBACK}}', feedback ? `## Notes from the last round, fix these\n\n${feedback}` : '');
  const allowed = ['Read', 'Glob', 'Grep', 'Edit', `Bash(${args.cli} pin:*)`, `Bash(${args.cli} verify:*)`];
  const result = await claude({ prompt, model: args['writer-model'], tools: 'Read,Glob,Grep,Edit,Bash', allowed });
  const denied = (result.permission_denials ?? []).map(({ tool_name: tool, tool_input: input }) => (input?.command ? `${tool}: ${input.command}` : tool));
  return { turns: result.num_turns, isError: result.is_error === true, denied };
}

/**
 * Throws away everything the writer changed except the listed modules, then pins and
 * verifies. If a module fails, the whole folder goes back to the crystallized state.
 */
async function keepOnlyVerifiedModules(keys, snapshot) {
  const editable = new Set(keys.map(moduleFileFor));
  const original = new Set(await readdir(snapshot));
  for (const file of await readdir(dir)) {
    if (!editable.has(file) && !original.has(file)) await rm(join(dir, file), { recursive: true, force: true });
  }
  for (const file of original) if (!editable.has(file)) await cp(join(snapshot, file), join(dir, file), { recursive: true });
  let problems;
  try {
    await pinCrystalFolder(dir);
    problems = await verify();
  } catch (error) {
    problems = [error.message];
  }
  if (problems.length === 0) return { verified: true, problems };
  await rm(dir, { recursive: true, force: true });
  await cp(snapshot, dir, { recursive: true });
  return { verified: false, reverted: true, problems };
}

async function verify() {
  const connector = postgresConnector({ url: databaseUrl });
  try {
    return await verifyCrystalFolder(dir, { connector });
  } finally {
    await connector.close();
  }
}

async function runReviewers(keys) {
  const modules = await modulesForReview(keys);
  return Promise.all(
    REVIEWERS.map(async (reviewer) => {
      const prompt = (await readFile(join(AGENTS_DIR, `${reviewer}.md`), 'utf8')).replaceAll('{{MODULES}}', modules);
      const result = await claude({ prompt, model: args['reviewer-model'], tools: '', allowed: [], schema: VERDICT_SCHEMA });
      const { verdict, problems } = result.structured_output ?? { verdict: 'reject', problems: ['the reviewer returned no verdict'] };
      return { reviewer, verdict, problems };
    }),
  );
}

async function modulesForReview(keys) {
  const { entries } = await readManifest(dir);
  const sections = [];
  for (const key of keys) {
    const entry = entries[key];
    const cases = parseCases(await readFile(join(dir, entry.cases), 'utf8'));
    const module = await readFile(join(dir, entry.file), 'utf8');
    const steps = cases.liquid.steps.map((step) => `SQL step "${step.name}", params ${JSON.stringify(step.params)}:\n\`\`\`sql\n${step.sql}\n\`\`\``);
    sections.push(
      [
        `### ${key.slice(0, KEY_PREFIX)}: ${entry.intent}`,
        `Input names and types: ${JSON.stringify(entry.paramTypes)}`,
        `Output shape: ${JSON.stringify(entry.output)}`,
        '',
        'Liquid reference:',
        ...steps,
        cases.liquid.shapeJs ? `shape(data, input), where data has one property per step:\n\`\`\`js\n${cases.liquid.shapeJs}\n\`\`\`` : 'shape: none (the step\'s rows are the output)',
        '',
        'Crystal module (shape takes the SQL rows directly):',
        `\`\`\`js\n${module}\`\`\``,
      ].join('\n'),
    );
  }
  return sections.join('\n\n');
}

function feedbackFor(gate, reviews) {
  const notes = [...(gate.verified ? [] : gate.problems.map((problem) => `verify: ${problem}`)), ...reviews.flatMap(({ reviewer, problems }) => problems.map((problem) => `${reviewer}: ${problem}`))];
  return notes.map((note) => `- ${note}`).join('\n');
}

async function changedModules(keys, snapshot) {
  const changed = [];
  for (const key of keys) {
    const file = moduleFileFor(key);
    const [before, after] = await Promise.all([readFile(join(snapshot, file), 'utf8'), readFile(join(dir, file), 'utf8')]);
    if (before !== after) changed.push(key);
  }
  return changed;
}

async function claude({ prompt, model, tools, allowed, schema }) {
  const emptyMcp = join(await mkdtemp(join(tmpdir(), 'crystal-agent-mcp-')), 'mcp.json');
  await writeFile(emptyMcp, '{"mcpServers":{}}');
  const flags = ['-p', prompt, '--output-format', 'json', '--model', model, '--tools', tools, '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', emptyMcp, '--max-budget-usd', args['max-budget-usd']];
  if (process.env.ANTHROPIC_API_KEY) flags.push('--bare');
  if (schema) flags.push('--json-schema', JSON.stringify(schema));
  if (allowed.length > 0) flags.push('--allowedTools', ...allowed);
  const { stdout } = await run('claude', flags, { cwd: REPO_ROOT, env: { ...process.env, CRYSTAL_DATABASE_URL: databaseUrl }, maxBuffer: 64 * 1024 * 1024, timeout: AGENT_TIMEOUT_MS });
  const result = JSON.parse(stdout);
  costUsd += result.total_cost_usd ?? 0;
  return result;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
