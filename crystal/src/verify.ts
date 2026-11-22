// `slime-crystal verify`: the gate for an edited Crystal folder, run against a real
// read-only database. Every Crystal must pass `check`, give the same output as the
// Liquid handler in its pinned cases on every recorded input, and cost no more to
// plan than that handler. Nothing a model or a reviewer says can pass it instead.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCases, type CrystalCases } from './cases.js';
import { checkCrystalFolder } from './check.js';
import { verifyCandidate, type EquivalenceDeps } from './equivalence.js';
import { readManifest, type ManifestEntry } from './manifest.js';
import { parseModule, type CrystalCode } from './module-format.js';
import { bindParams, isApiStep, queryLimits } from '@slime-cloud/core/tooling';
import { DEFAULT_LIMITS, QuickJSRunner, type Artifact, type Connector, type HandlerRecord, type InputValues, type LimitOptions, type SandboxRunner, type SqlStep } from '@slime-cloud/core';

export interface VerifyOptions {
  /** A read-only connector: both the Liquid reference and the Crystal run against it. */
  connector: Connector;
  /** A sandbox the host shares; omit for the job's own. */
  runner?: SandboxRunner;
  limits?: Partial<LimitOptions>;
}

// Planner estimates move a little between equivalent queries; more than this is a regression.
export const COST_TOLERANCE = 1.1;
const NO_CASES = 'has no cases file (made before verify existed); crystallize it again';

/** Every problem in the folder; empty means every Crystal is equivalent to its Liquid handler and no costlier. */
export async function verifyCrystalFolder(dir: string, options: VerifyOptions): Promise<string[]> {
  const checked = await checkCrystalFolder(dir);
  if (checked.length > 0) return checked;
  const manifest = await readManifest(dir);
  const runner = options.runner ?? new QuickJSRunner();
  const deps: EquivalenceDeps = { connector: options.connector, runner, limits: { ...DEFAULT_LIMITS, ...options.limits } };
  try {
    const problems: string[] = [];
    for (const [key, entry] of Object.entries(manifest.entries)) {
      const problem = await crystalProblem(dir, deps, key, entry);
      if (problem) problems.push(`${key}: ${problem}`);
    }
    return problems;
  } finally {
    if (!options.runner) await runner.close();
  }
}

async function crystalProblem(dir: string, deps: EquivalenceDeps, key: string, entry: ManifestEntry): Promise<string | undefined> {
  if (!entry.cases) return NO_CASES;
  try {
    const cases = parseCases(await readFile(join(dir, entry.cases), 'utf8'));
    const code = parseModule(await readFile(join(dir, entry.file), 'utf8'));
    await verifyCandidate(deps, referenceRecord(key, entry, cases), code);
    return await costProblem(deps, cases, code);
  } catch (error) {
    return (error as Error).message;
  }
}

function referenceRecord(key: string, entry: ManifestEntry, { liquid, inputs }: CrystalCases): HandlerRecord {
  const { intent, output, paramTypes, provenance, review, createdAt } = entry;
  return { key, intent, output, paramTypes, provenance, review, createdAt, artifact: liquid, fixtures: inputs, tier: 'liquid', runs: inputs.length };
}

async function costProblem(deps: EquivalenceDeps, { liquid, inputs }: CrystalCases, code: CrystalCode): Promise<string | undefined> {
  const input = inputs[0] ?? {};
  const crystalCost = await planCost(deps, code.sql, code.params, input);
  const liquidCost = await liquidPlanCost(deps, liquid, input);
  if (crystalCost === null || liquidCost === null || crystalCost <= liquidCost * COST_TOLERANCE) return undefined;
  return `plans at cost ${crystalCost}, above the Liquid handler's ${liquidCost}`;
}

async function liquidPlanCost(deps: EquivalenceDeps, liquid: Artifact, input: InputValues): Promise<number | null> {
  const sqlSteps = liquid.steps.filter((step): step is SqlStep => !isApiStep(step));
  let total = 0;
  for (const step of sqlSteps) {
    const cost = await planCost(deps, step.sql, step.params, input);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

async function planCost({ connector, limits }: EquivalenceDeps, sql: string, params: readonly string[], input: InputValues): Promise<number | null> {
  return (await connector.check(sql, bindParams(params, input), queryLimits(limits))).cost;
}
