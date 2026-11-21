// The crystallize job: turns proven Liquid handlers into Crystal modules in the
// app's own code (C10). The app runs it from its own script with its own config.
import { asV1, isArtifactV2 } from '../models/artifact-v2.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LIMITS } from '../config/defaults.js';
import type { LimitOptions } from '../config/options.js';
import { HANDLERS_NS } from '../engine/handler-cache.js';
import { forModel } from '../engine/generate.js';
import type { HandlerRecord } from '../engine/types.js';
import { changedProvenance, type HandlerProvenance } from '../request/key.js';
import type { Connector } from '../connectors/types.js';
import type { Optimizer } from '../models/types.js';
import { QuickJSRunner } from '../sandbox/quickjs/quickjs-runner.js';
import type { SlimeStore } from '../stores/types.js';
import { verifyCandidate, type EquivalenceDeps } from './equivalence.js';
import { sha256 } from '../shared/hash.js';
import { moduleFileFor, readManifest, writeManifestAndIndex, type Manifest } from './manifest.js';
import type { CrystalCode } from './module-format.js';

export interface CrystallizeOptions {
  /** A read-only connector: the equivalence test runs both versions against the database. */
  connector: Connector;
  /** The store explore mode filled with Liquid handlers. */
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
  optimizeTimeoutMs?: number;
  /** Check everything, write nothing. */
  isDryRun?: boolean;
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
const SKIPPED_API_STEPS = 'has API steps, which Crystal does not support yet';

export async function crystallize(options: CrystallizeOptions): Promise<CrystalReport[]> {
  const runner = new QuickJSRunner();
  const context: JobContext = {
    options,
    deps: { connector: options.connector, runner, limits: { ...DEFAULT_LIMITS, ...options.limits } },
    manifest: await readManifest(options.dir),
    minRuns: options.minRuns ?? DEFAULT_MIN_RUNS,
    provenance: options.provenance,
  };
  try {
    const saved = await options.store.list(HANDLERS_NS);
    const reports: CrystalReport[] = [];
    for (const { value } of saved) reports.push(await crystallizeOne(context, value as HandlerRecord));
    const hasNewCrystal = reports.some(({ outcome }) => outcome === 'crystallized');
    if (hasNewCrystal && !options.isDryRun) await writeManifestAndIndex(options.dir, context.manifest);
    return reports;
  } finally {
    await runner.close();
  }
}

async function crystallizeOne(context: JobContext, record: HandlerRecord): Promise<CrystalReport> {
  const report: CrystalReport = { key: record.key, intent: record.intent, outcome: 'not-ready', reasons: [] };
  if (context.manifest.entries[record.key]) return { ...report, outcome: 'already' };
  // MS9: every stored v2 handler has an API step (single-SQL ones were stored as v1).
  if (isArtifactV2(record.artifact)) return { ...report, outcome: 'skipped', reasons: [SKIPPED_API_STEPS] };
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

/** The optimized version first, when there is an optimizer; the unchanged Liquid code always. */
async function candidatesFor({ options }: JobContext, record: HandlerRecord, report: CrystalReport): Promise<Candidate[]> {
  const { sql, params, shapeJs } = asV1(record.artifact, 'crystallize'); // v2 records were skipped in crystallizeOne
  const unchanged: Candidate = { code: { sql, params, shape: shapeJs }, isOptimized: false, notes: [] };
  if (!options.optimizer) return [unchanged];
  try {
    const request = { sql, params, shapeJs, output: record.output, paramTypes: forModel(record.paramTypes) };
    const { code } = await options.optimizer.optimize(request, { timeoutMs: options.optimizeTimeoutMs ?? DEFAULT_OPTIMIZE_TIMEOUT_MS });
    return [{ code: { sql: code.sql, params: code.params, shape: code.shape }, isOptimized: true, notes: code.notes }, unchanged];
  } catch (error) {
    report.reasons.push(`optimizer: ${(error as Error).message}`);
    return [unchanged];
  }
}

async function saveCrystal({ options, manifest }: JobContext, record: HandlerRecord, candidate: Candidate, text: string): Promise<void> {
  const file = moduleFileFor(record.key);
  await mkdir(options.dir, { recursive: true });
  await writeFile(join(options.dir, file), text);
  const { intent, output, paramTypes, provenance, review } = record;
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
  };
}
