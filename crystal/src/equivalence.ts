import { checkShapeSource } from './allowlist.js';
import { importCheckedModule } from './import-module.js';
import { inputNamesOf, isStepsCode, renderModule, type CrystalCode } from './module-format.js';
import type { ApiSchema, Connector, CrystalHandler, HandlerRecord, InputValues, LimitOptions, SandboxRunner, Source } from '@slime-cloud/core';
import { canonicalJSON, executeArtifact, runCrystal } from '@slime-cloud/core/tooling';

export interface EquivalenceDeps {
  connector: Connector;
  runner: SandboxRunner;
  limits: Readonly<LimitOptions>;
  /** The app's sources and their schemas: API steps run through them. Without them, only SQL steps can run. */
  sources?: Readonly<Record<string, Source>>;
  apiSchemas?: Readonly<Record<string, ApiSchema>>;
}

// Float noise from a reordered SQL sum is not a difference.
const SIGNIFICANT_DIGITS = 9;

/**
 * Every check a candidate must pass: the allowlist, the read-only lint, an import of the
 * module text (apps import it), and the same output as the Liquid handler on every recorded
 * input. Returns the module text.
 *
 * The comparison runs the module's shape as source in the sandbox, with Liquid's limits:
 * Liquid runs there too, so like is compared with like, and a candidate that loops cannot
 * stall the job's process, which may be serving other endpoints.
 */
export async function verifyCandidate(deps: EquivalenceDeps, record: HandlerRecord, code: CrystalCode): Promise<string> {
  if (code.shape) checkShapeSource(code.shape);
  const unknownInput = inputNamesOf(code).find((name) => !(name in record.paramTypes));
  if (unknownInput) throw new Error(`input "${unknownInput}" is not an input of this request`);
  const text = renderModule(code);
  const candidate = asCrystal(record, await importCheckedModule(text));

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
    return (await executeArtifact({ ...deps, sources: deps.sources ?? {}, apiSchemas: deps.apiSchemas ?? {} }, { artifact, output, input })).data;
  } catch {
    return NOT_COMPARABLE;
  }
}

function asCrystal(record: HandlerRecord, code: CrystalCode): CrystalHandler {
  const { intent, output, paramTypes, provenance, review } = record;
  const metadata = { intent, output, paramTypes, schemaHash: provenance.schemaHash, review };
  return isStepsCode(code) ? { steps: code.steps, shape: code.shape, ...metadata } : { sql: code.sql, params: code.params, shape: code.shape, ...metadata };
}

function normalized(value: unknown): string {
  const rounded = JSON.parse(JSON.stringify(value), (_key, field: unknown) =>
    typeof field === 'number' && !Number.isInteger(field) ? Number(field.toPrecision(SIGNIFICANT_DIGITS)) : field,
  );
  return canonicalJSON(rounded);
}
