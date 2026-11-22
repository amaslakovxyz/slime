// `slime-crystal verify`: the gate for an edited Crystal folder, run against a real
// read-only database. Every Crystal must pass `check`, give the same output as the
// Liquid handler in its pinned cases on every recorded input, and cost no more to
// plan than that handler. Nothing a model or a reviewer says can pass it instead.
//
// A Crystal that calls API sources needs the app's sources to run. Without them (the
// CLI, the merge gate) it passes only while it is exactly its Liquid code; an edited
// one is verified on the app's instance (Crystallizer.verify), which has them.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCases, type CrystalCases } from './cases.js';
import { checkCrystalFolder } from './check.js';
import { verifyCandidate, type EquivalenceDeps } from './equivalence.js';
import { readManifest, type ManifestEntry } from './manifest.js';
import { apiSourcesOf, parseModule, renderModule, sqlStatementsOf, type CrystalCode, type SqlStatement } from './module-format.js';
import { bindParams, canonicalJSON, isApiStep, queryLimits } from '@slime-cloud/core/tooling';
import {
  DEFAULT_LIMITS,
  QuickJSRunner,
  type ApiSchema,
  type Artifact,
  type Connector,
  type HandlerRecord,
  type InputValues,
  type LimitOptions,
  type SandboxRunner,
  type Source,
  type SqlStep,
} from '@slime-cloud/core';

export interface VerifyOptions {
  /** A read-only connector: both the Liquid reference and the Crystal run against it. */
  connector: Connector;
  /** The app's sources and their schemas, for Crystals that call API sources (Crystallizer.verify passes the instance's). */
  sources?: Readonly<Record<string, Source>>;
  apiSchemas?: Readonly<Record<string, ApiSchema>>;
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
  const deps: EquivalenceDeps = {
    connector: options.connector,
    runner,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    ...(options.sources ? { sources: options.sources } : {}),
    ...(options.apiSchemas ? { apiSchemas: options.apiSchemas } : {}),
  };
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
    const missing = apiSourcesOf(code).filter((name) => !deps.sources?.[name]);
    if (missing.length > 0) return isLiquidCode(code, cases.liquid) ? undefined : editedWithoutSources(missing);
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

function editedWithoutSources(missing: readonly string[]): string {
  return `it was edited and calls ${missing.join(', ')}: verify it where the app's sources are (Crystallizer.verify), or crystallize it again`;
}

/** The module is its Liquid handler's code, as crystallize writes it: equivalent by construction. */
function isLiquidCode(code: CrystalCode, liquid: Artifact): boolean {
  const asWritten = parseModule(renderModule({ steps: liquid.steps, shape: liquid.shapeJs }));
  return canonicalJSON(code) === canonicalJSON(asWritten);
}

async function costProblem(deps: EquivalenceDeps, { liquid, inputs }: CrystalCases, code: CrystalCode): Promise<string | undefined> {
  const input = inputs[0] ?? {};
  const crystalCost = await totalPlanCost(deps, sqlStatementsOf(code), input);
  const liquidCost = await totalPlanCost(deps, liquid.steps.filter((step): step is SqlStep => !isApiStep(step)), input);
  if (crystalCost === null || liquidCost === null || crystalCost <= liquidCost * COST_TOLERANCE) return undefined;
  return `plans at cost ${crystalCost}, above the Liquid handler's ${liquidCost}`;
}

/** The SQL statements' plan costs, summed; null when the connector gives no cost. */
async function totalPlanCost(deps: EquivalenceDeps, statements: readonly SqlStatement[], input: InputValues): Promise<number | null> {
  let total = 0;
  for (const { sql, params } of statements) {
    const cost = await planCost(deps, sql, params, input);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

async function planCost({ connector, limits }: EquivalenceDeps, sql: string, params: readonly string[], input: InputValues): Promise<number | null> {
  return (await connector.check(sql, bindParams(params, input), queryLimits(limits))).cost;
}
