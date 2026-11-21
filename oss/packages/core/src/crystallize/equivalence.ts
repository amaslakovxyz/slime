import type { LimitOptions } from '../config/options.js';
import { runCrystal } from '../crystal/run-crystal.js';
import type { CrystalHandler } from '../crystal/types.js';
import { executeArtifact } from '../engine/execute.js';
import type { HandlerRecord } from '../engine/types.js';
import type { Connector, SandboxRunner } from '../ports.js';
import { canonicalJSON } from '../request/key.js';
import type { InputValues } from '../request/parse.js';
import { checkShapeSource } from './allowlist.js';
import { importCheckedModule } from './import-module.js';
import { renderModule, type CrystalCode } from './module-format.js';

export interface EquivalenceDeps {
  connector: Connector;
  runner: SandboxRunner;
  limits: Readonly<LimitOptions>;
}

// Float noise from a reordered SQL sum is not a difference.
const SIGNIFICANT_DIGITS = 9;

/**
 * Every check a candidate must pass: the allowlist, the read-only lint, and the
 * same output as the Liquid handler on every recorded input. Returns the module text.
 */
export async function verifyCandidate(deps: EquivalenceDeps, record: HandlerRecord, code: CrystalCode): Promise<string> {
  if (code.shape) checkShapeSource(code.shape);
  const unknownParam = code.params.find((name) => !(name in record.paramTypes));
  if (unknownParam) throw new Error(`param "${unknownParam}" is not an input of this request`);
  const text = renderModule(code);
  const candidate = asCrystal(record, code, (await importCheckedModule(text)).shape);

  let comparedCount = 0;
  for (const input of record.fixtures) {
    const expected = await liquidOutput(deps, record, input);
    if (expected === NOT_COMPARABLE) continue;
    const actual = (await runCrystal(deps, candidate, input)).data;
    if (normalized(actual) !== normalized(expected)) throw new Error(`differs from Liquid for recorded input ${JSON.stringify(input)}`);
    comparedCount++;
  }
  if (comparedCount === 0) throw new Error('no recorded input could be compared');
  return text;
}

const NOT_COMPARABLE = Symbol('not comparable');

/** Liquid exactly as it runs today; an input it no longer answers has nothing to compare against. */
async function liquidOutput(deps: EquivalenceDeps, { artifact, output }: HandlerRecord, input: InputValues): Promise<unknown> {
  try {
    return (await executeArtifact(deps, { artifact, output, input })).data;
  } catch {
    return NOT_COMPARABLE;
  }
}

function asCrystal(record: HandlerRecord, code: CrystalCode, shape: CrystalHandler['shape']): CrystalHandler {
  const { intent, output, paramTypes, provenance, review } = record;
  return { sql: code.sql, params: code.params, shape, intent, output, paramTypes, schemaHash: provenance.schemaHash, review };
}

function normalized(value: unknown): string {
  const rounded = JSON.parse(JSON.stringify(value), (_key, field: unknown) =>
    typeof field === 'number' && !Number.isInteger(field) ? Number(field.toPrecision(SIGNIFICANT_DIGITS)) : field,
  );
  return canonicalJSON(rounded);
}
