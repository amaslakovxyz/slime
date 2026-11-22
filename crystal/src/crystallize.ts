// The crystallize job: turns proven Liquid handlers into Crystal modules in the
// app's own code (C10). The app runs it from its own script with its own config.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyCandidate, type EquivalenceDeps } from './equivalence.js';
import { moduleFileFor, readManifest, writeManifestAndIndex, type Manifest } from './manifest.js';
import { apiSourcesOf, type CrystalCode } from './module-format.js';
import { serviceNameFor, serviceNames } from './services.js';
import { casesFileFor, renderCases } from './cases.js';
import { HANDLERS_NS, SQL_SOURCE_DEFAULT_NAME, asSingleQuery, paramTypesForModel, recordFromStore, sha256 } from '@slime-cloud/core/tooling';
import { DEFAULT_LIMITS, QuickJSRunner, changedProvenance, type ApiSchema, type Connector, type HandlerProvenance, type HandlerRecord, type LimitOptions, type Optimizer, type SandboxRunner, type SlimeStore, type Source } from '@slime-cloud/core';

export interface CrystallizeOptions {
  /** A read-only connector: the equivalence test runs both versions against the database. */
  connector: Connector;
  /** The app's sources and their schemas, for handlers with API steps; without them those fail the equivalence test. */
  sources?: Readonly<Record<string, Source>>;
  apiSchemas?: Readonly<Record<string, ApiSchema>>;
  /** The SQL source's name, for handlers saved before steps existed. */
  sqlSourceName?: string;
  /** The store Slime filled with Liquid handlers. */
  store: SlimeStore;
  /** The Crystal folder in the app, for example './slime-crystal'. */
  dir: string;
  /** Omit to move Liquid code over unchanged, if it passes the allowlist. */
  optimizer?: Optimizer;
  /** Successful runs a Liquid handler needs before it is crystallized. */
  minRuns?: number;
  /** Current provenance; a handler made with another one is not ready. */
  provenance?: HandlerProvenance;
  limits?: Partial<LimitOptions>;
  /** A sandbox the host shares; the job uses it and leaves it running. Omit for the job's own. */
  runner?: SandboxRunner;
  optimizeTimeoutMs?: number;
  /** Check everything, write nothing. */
  isDryRun?: boolean;
  /** Only these request keys; omit for every saved handler. */
  keys?: readonly string[];
}

export type CrystalOutcome = 'crystallized' | 'already' | 'not-ready' | 'skipped' | 'failed';

export interface CrystalReport {
  key: string;
  intent: string;
  outcome: CrystalOutcome;
  isOptimized?: boolean;
  reasons: string[];
}

interface Candidate {
  code: CrystalCode;
  isOptimized: boolean;
  notes: string[];
}

interface JobContext {
  options: CrystallizeOptions;
  deps: EquivalenceDeps;
  manifest: Manifest;
  minRuns: number;
  provenance: HandlerProvenance | undefined;
}

export const DEFAULT_MIN_RUNS = 10;
const DEFAULT_OPTIMIZE_TIMEOUT_MS = 120_000;
const REVIEWS_ALLOWED = new Set(['approved', 'none']);
const SKIPPED_UNSATISFIABLE = 'unsatisfiable: it answers nothing to crystallize';

export async function crystallize(options: CrystallizeOptions): Promise<CrystalReport[]> {
  const runner = options.runner ?? new QuickJSRunner();
  const context: JobContext = {
    options,
    deps: {
      connector: options.connector,
      runner,
      limits: { ...DEFAULT_LIMITS, ...options.limits },
      ...(options.sources ? { sources: options.sources } : {}),
      ...(options.apiSchemas ? { apiSchemas: options.apiSchemas } : {}),
    },
    manifest: await readManifest(options.dir),
    minRuns: options.minRuns ?? DEFAULT_MIN_RUNS,
    provenance: options.provenance,
  };
  try {
    const picked = options.keys ? new Set(options.keys) : undefined;
    const saved = (await options.store.list(HANDLERS_NS)).filter(({ key }) => !picked || picked.has(key));
    const reports: CrystalReport[] = [];
    const sqlSourceName = options.sqlSourceName ?? SQL_SOURCE_DEFAULT_NAME;
    for (const { value } of saved) reports.push(await crystallizeOne(context, recordFromStore(value, sqlSourceName)));
    const hasNewCrystal = reports.some(({ outcome }) => outcome === 'crystallized');
    if (hasNewCrystal && !options.isDryRun) await writeManifestAndIndex(options.dir, context.manifest);
    return reports;
  } finally {
    if (!options.runner) await runner.close();
  }
}

async function crystallizeOne(context: JobContext, record: HandlerRecord): Promise<CrystalReport> {
  const report: CrystalReport = { key: record.key, intent: record.intent, outcome: 'not-ready', reasons: [] };
  if (context.manifest.entries[record.key]) return { ...report, outcome: 'already' };
  if (record.artifact.unsatisfiable || record.artifact.steps.length === 0) return { ...report, outcome: 'skipped', reasons: [SKIPPED_UNSATISFIABLE] };
  const notReadyReason = readinessProblem(record, context.minRuns, context.provenance);
  if (notReadyReason) return { ...report, reasons: [notReadyReason] };

  report.outcome = 'failed';
  for (const candidate of await candidatesFor(context, record, report)) {
    try {
      const text = await verifyCandidate(context.deps, record, candidate.code);
      if (!context.options.isDryRun) await saveCrystal(context, record, candidate, text);
      return { ...report, outcome: 'crystallized', isOptimized: candidate.isOptimized };
    } catch (error) {
      report.reasons.push(`${candidate.isOptimized ? 'optimized version' : 'unchanged Liquid code'}: ${(error as Error).message}`);
    }
  }
  return report;
}

function readinessProblem(
  { tier, review, runs, fixtures, provenance: made }: HandlerRecord,
  minRuns: number,
  provenance?: HandlerProvenance,
): string | undefined {
  if (tier !== 'liquid') return `tier is ${tier}`;
  const changed = provenance ? changedProvenance(made, provenance) : [];
  if (changed.length) return `made with another ${changed.join(', ')}`;
  if (!REVIEWS_ALLOWED.has(review)) return `review is ${review}`;
  if (runs < minRuns) return `${runs} of ${minRuns} successful runs`;
  if (fixtures.length === 0) return 'no recorded inputs to test against';
  return undefined;
}

/**
 * A handler that is one SQL query becomes a query Crystal: the optimized version first, when
 * there is an optimizer, and the unchanged Liquid code always. Any other handler (API steps,
 * several steps) becomes a steps Crystal with its Liquid code unchanged; the optimizer
 * rewrites one query only, and the Crystal agents can still edit it behind `verify`.
 */
async function candidatesFor({ options }: JobContext, record: HandlerRecord, report: CrystalReport): Promise<Candidate[]> {
  const query = asSingleQuery(record.artifact);
  if (!query) return [{ code: { steps: record.artifact.steps, shape: record.artifact.shapeJs }, isOptimized: false, notes: [] }];
  const { sql, params, shapeJs } = query;
  const unchanged: Candidate = { code: { sql, params, shape: shapeJs }, isOptimized: false, notes: [] };
  if (!options.optimizer) return [unchanged];
  try {
    const request = { sql, params, shapeJs, output: record.output, paramTypes: paramTypesForModel(record.paramTypes) };
    const { code } = await options.optimizer.optimize(request, { timeoutMs: options.optimizeTimeoutMs ?? DEFAULT_OPTIMIZE_TIMEOUT_MS });
    return [{ code: { sql: code.sql, params: code.params, shape: code.shape }, isOptimized: true, notes: code.notes }, unchanged];
  } catch (error) {
    report.reasons.push(`optimizer: ${(error as Error).message}`);
    return [unchanged];
  }
}

async function saveCrystal({ options, manifest }: JobContext, record: HandlerRecord, candidate: Candidate, text: string): Promise<void> {
  const file = moduleFileFor(record.key);
  const casesFile = casesFileFor(record.key);
  const casesText = renderCases({ liquid: record.artifact, inputs: record.fixtures });
  await mkdir(options.dir, { recursive: true });
  await writeFile(join(options.dir, file), text);
  await writeFile(join(options.dir, casesFile), casesText);
  const { intent, output, paramTypes, provenance, review } = record;
  const apiSources = apiSourcesOf(candidate.code);
  manifest.entries[record.key] = {
    file,
    sha256: sha256(text),
    intent,
    output,
    paramTypes,
    schemaHash: provenance.schemaHash,
    review,
    isOptimized: candidate.isOptimized,
    notes: candidate.notes,
    provenance,
    createdAt: new Date().toISOString(),
    service: serviceNameFor(intent, record.key, new Set(serviceNames(manifest).values())),
    cases: casesFile,
    casesSha256: sha256(casesText),
    ...(apiSources.length > 0 ? { sources: apiSources } : {}),
  };
}
