// Turns proven Liquid handlers into Crystal modules in the Crystal folder.
//
// For each Liquid handler with enough successful runs and an approved review:
//   1. the optimizer agent rewrites it (code only, never the request text or data);
//   2. the candidate must pass the allowlist, the read-only SQL lint and EXPLAIN;
//   3. the equivalence test runs the Liquid version and the candidate on every
//      recorded input against the live database and requires identical output;
//   4. if the optimized version fails anywhere, the unchanged Liquid code is tried
//      the same way (it may still fail the stricter Crystal allowlist);
//   5. only a passing candidate is written: module + recorded runs + manifest entry.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Connector } from '../connectors/types.js';
import { canonicalJSON, crystalKey } from '../fingerprint.js';
import { runShape } from '../sandbox.js';
import { validateAgainstShape } from '../shape.js';
import { codeHash, type HandlerStore, type StoreScope, type StoredHandler } from '../store.js';
import { importModuleText, readManifest, sha256Hex, writeManifest, type Manifest } from './loader.js';
import { checkShapeSource, renderModule, type CrystalCode } from './module.js';
import type { Optimizer } from './optimizers.js';

export interface CrystallizeOptions {
  connector: Connector;
  store: HandlerStore;
  dir: string;
  schemaHash: string;
  scope: StoreScope;
  minRuns: number;
  optimizer: Optimizer | null;
  optimizeTimeoutMs?: number;
  dryRun?: boolean;
}

export type CrystalOutcome = 'crystallized' | 'already' | 'not-ready' | 'failed';

export interface CrystalReport {
  key: string;
  intent: string;
  outcome: CrystalOutcome;
  optimized?: boolean;
  file?: string;
  reasons: string[];
}

interface Candidate {
  code: CrystalCode;
  optimized: boolean;
  notes: string[];
}

export async function crystallize(opts: CrystallizeOptions): Promise<CrystalReport[]> {
  const manifest = readManifest(opts.dir);
  const rows = await opts.store.loadLiquid(opts.scope);
  const reports: CrystalReport[] = [];
  let changed = false;

  for (const row of rows) {
    const key = crystalKey(row.fingerprint, opts.schemaHash);
    const report: CrystalReport = { key, intent: row.intent, outcome: 'not-ready', reasons: [] };
    reports.push(report);

    if (manifest.entries[key]) {
      report.outcome = 'already';
      continue;
    }
    if (row.review.status !== 'approved' && row.review.status !== 'skipped') {
      report.reasons.push(`review is ${row.review.status}`);
      continue;
    }
    if (row.runs < opts.minRuns) {
      report.reasons.push(`${row.runs} of ${opts.minRuns} successful runs`);
      continue;
    }
    if (row.fixtures.length === 0) {
      report.reasons.push('no recorded runs to test against');
      continue;
    }
    if (codeHash(row.artifact) !== row.codeHash) {
      report.outcome = 'failed';
      report.reasons.push('stored Liquid code does not match its hash');
      continue;
    }

    const candidates: Candidate[] = [];
    if (opts.optimizer) {
      try {
        const o = await opts.optimizer.optimize(
          { sql: row.artifact.sql, params: row.artifact.params, shapeJs: row.artifact.shapeJs, output: row.output, inputSig: row.inputSig },
          opts.optimizeTimeoutMs ?? 120_000,
        );
        candidates.push({ code: { sql: o.sql, params: o.params, shape: o.shape }, optimized: true, notes: o.notes });
      } catch (err) {
        report.reasons.push(`optimizer: ${(err as Error).message}`);
      }
    }
    candidates.push({ code: { sql: row.artifact.sql, params: row.artifact.params, shape: row.artifact.shapeJs }, optimized: false, notes: [] });

    report.outcome = 'failed';
    for (const candidate of candidates) {
      const label = candidate.optimized ? 'optimized version' : 'unchanged Liquid code';
      try {
        const text = await verify(candidate.code, row, opts.connector);
        report.outcome = 'crystallized';
        report.optimized = candidate.optimized;
        report.file = `${key}.mjs`;
        if (!opts.dryRun) {
          writeCrystal(opts.dir, manifest, key, text, row, candidate, opts.schemaHash, await recordRuns(row, text, opts.connector));
          changed = true;
        }
        break;
      } catch (err) {
        report.reasons.push(`${label}: ${(err as Error).message}`);
      }
    }
  }

  if (changed) writeManifest(opts.dir, manifest);
  return reports;
}

/** Every check a candidate must pass. Returns the module text that was checked. */
async function verify(code: CrystalCode, row: StoredHandler, connector: Connector): Promise<string> {
  if (code.shape) checkShapeSource(code.shape);
  for (const name of code.params) {
    if (!(name in row.inputSig)) throw new Error(`param "${name}" is not an input of this request`);
  }
  const text = renderModule(code);
  const crystal = await importModuleText(text); // allowlist + read-only SQL lint, then import

  let compared = 0;
  for (const fixture of row.fixtures) {
    // Liquid exactly as it runs today: SQL, then shaping in the sandbox worker.
    let expected: unknown;
    try {
      expected = await runHandler(connector, row.artifact.sql, row.artifact.params, fixture.input, async (rows) =>
        row.artifact.shapeJs ? (await runShape(row.artifact.shapeJs, rows, fixture.input)).data : rows,
      );
    } catch {
      continue; // the reference itself no longer runs for this input; nothing to compare
    }
    await connector.check(crystal.code.sql, bind(crystal.code.params, fixture.input));
    const actual = await runHandler(connector, crystal.code.sql, crystal.code.params, fixture.input, async (rows) =>
      crystal.shape ? crystal.shape(rows, fixture.input) : rows,
    );
    const mismatches = validateAgainstShape(row.output, actual);
    if (mismatches.length) throw new Error(`output does not match the requested shape: ${mismatches.slice(0, 3).join('; ')}`);
    if (normalize(actual) !== normalize(expected)) {
      throw new Error(`differs from Liquid for recorded input ${JSON.stringify(fixture.input)}`);
    }
    compared++;
  }
  if (compared === 0) throw new Error('no recorded input could be compared');
  return text;
}

async function runHandler(
  connector: Connector,
  sql: string,
  params: string[],
  input: Record<string, unknown>,
  shape: (rows: Record<string, unknown>[]) => Promise<unknown>,
): Promise<unknown> {
  const run = await connector.run(sql, bind(params, input));
  return shape(run.rows);
}

const bind = (params: string[], input: Record<string, unknown>) => params.map((name) => input[name] ?? null);

/** Exact comparison except for float noise: numbers are rounded to 9 significant digits. List order counts. */
function normalize(value: unknown): string {
  return canonicalJSON(
    JSON.parse(JSON.stringify(value), (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(9)) : v)),
  );
}

/** Current Crystal output for each recorded input, saved next to the module for people and CI. */
async function recordRuns(row: StoredHandler, text: string, connector: Connector) {
  const crystal = await importModuleText(text);
  const runs = [];
  for (const fixture of row.fixtures) {
    try {
      const output = await runHandler(connector, crystal.code.sql, crystal.code.params, fixture.input, async (rows) =>
        crystal.shape ? crystal.shape(rows, fixture.input) : rows,
      );
      runs.push({ input: fixture.input, output });
    } catch {
      // skipped: the comparison above already decided whether this crystal is valid
    }
  }
  return runs;
}

function writeCrystal(
  dir: string,
  manifest: Manifest,
  key: string,
  text: string,
  row: StoredHandler,
  candidate: Candidate,
  schemaHash: string,
  runs: { input: Record<string, unknown>; output: unknown }[],
) {
  writeFileSyncMkdir(join(dir, `${key}.mjs`), text);
  writeFileSyncMkdir(join(dir, `${key}.fixtures.json`), `${JSON.stringify({ recordedAt: new Date().toISOString(), runs }, null, 2)}\n`);
  manifest.entries[key] = {
    file: `${key}.mjs`,
    sha256: sha256Hex(text),
    fixtures: `${key}.fixtures.json`,
    fingerprint: row.fingerprint,
    schemaHash,
    intent: row.intent,
    inputSig: row.inputSig,
    output: row.output,
    optimized: candidate.optimized,
    notes: candidate.notes,
    from: { artifactKey: row.artifactKey, model: row.model, promptHash: row.promptHash, revision: row.revision },
    createdAt: new Date().toISOString(),
  };
}

function writeFileSyncMkdir(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
