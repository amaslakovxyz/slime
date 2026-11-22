// A handler as the model writes it: steps across sources, combined by shapeJs (MS3, MS4;
// docs/request-format.md "Multi-source handlers").

export const ARTIFACT_VERSION = 2;

export interface SqlStep {
  name: string;
  /** The SQL source's name. */
  source: string;
  sql: string;
  /** params[0] is the input name bound to $1. */
  params: string[];
}

/** Exactly one of `input` and `value` is non-null; lint enforces it (MS4). */
export interface ApiArg {
  param: string;
  input: string | null;
  value: string | number | boolean | null;
}

export interface ApiStep {
  name: string;
  source: string;
  operation: string;
  args: ApiArg[];
}

export type Step = SqlStep | ApiStep;

export interface Artifact {
  version: typeof ARTIFACT_VERSION;
  /** null, or one sentence on why the sources can't answer the request. */
  unsatisfiable: string | null;
  steps: Step[];
  /** Source of `function shape(data, input)`; null only with a single step whose rows are the output. */
  shapeJs: string | null;
  assumptions: string[];
}

/** The single-query form stored before steps existed. Read from old records only; never generated. */
export interface LegacyArtifact {
  unsatisfiable: string | null;
  sql: string;
  params: string[];
  /** Source of `function shape(rows, input)`. */
  shapeJs: string | null;
  assumptions: string[];
}

/** One SQL query with `function shape(rows, input)`: the form Crystal runs (C10). */
export interface SingleQuery {
  sql: string;
  params: string[];
  shapeJs: string | null;
}

const LEGACY_STEP_NAME = 'rows';
const STEP_SEPARATOR = (name: string): string => `\n-- step ${name}\n`;

export function isApiStep(step: Step): step is ApiStep {
  return 'operation' in step;
}

/** Old records hold a LegacyArtifact; everything past the store sees steps. */
export function fromStoredArtifact(stored: Artifact | LegacyArtifact, sqlSourceName: string): Artifact {
  if ('steps' in stored) return stored;
  const { unsatisfiable, sql, params, shapeJs, assumptions } = stored;
  const steps = unsatisfiable ? [] : [{ name: LEGACY_STEP_NAME, source: sqlSourceName, sql, params }];
  return { version: ARTIFACT_VERSION, unsatisfiable, steps, shapeJs: shapeJs && dataShape(LEGACY_STEP_NAME, shapeJs), assumptions };
}

/** A handler that is one SQL step, as one query; undefined when it has API steps or several steps. */
export function asSingleQuery({ steps, shapeJs }: Artifact): SingleQuery | undefined {
  const [step] = steps;
  if (steps.length !== 1 || !step || isApiStep(step)) return undefined;
  return { sql: step.sql, params: step.params, shapeJs: shapeJs && rowsShape(step.name, shapeJs) };
}

/** The SQL a handler runs, its SQL steps joined, for meta and events (R9). */
export function sqlOf(artifact: Artifact): string {
  return artifact.steps
    .filter((step): step is SqlStep => !isApiStep(step))
    .map((step, index) => (index === 0 ? step.sql : `${STEP_SEPARATOR(step.name)}${step.sql}`))
    .join('');
}

// The original function is nested, not rewritten: the inner declaration shadows the outer
// one, which the sandbox and the Crystal allowlist both accept.
function dataShape(stepName: string, rowsShapeJs: string): string {
  return `function shape(data, input) {\n${rowsShapeJs}\nreturn shape(data.${stepName}, input);\n}`;
}

function rowsShape(stepName: string, dataShapeJs: string): string {
  return `function shape(rows, input) {\n${dataShapeJs}\nreturn shape({ ${stepName}: rows }, input);\n}`;
}
