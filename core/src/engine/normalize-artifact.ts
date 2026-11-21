// A v2 handler whose only step is SQL becomes v1 before its first run, so the
// stored code is the code that ran and Crystal, meta and review stay v1 (MS3).
import { isApiStep, isArtifactV2, type AnyArtifact } from '../models/artifact-v2.js';

export function normalizeArtifact(artifact: AnyArtifact): AnyArtifact {
  if (!isArtifactV2(artifact) || artifact.unsatisfiable || artifact.steps.length !== 1) return artifact;
  const [step] = artifact.steps;
  if (!step || isApiStep(step)) return artifact;
  return { unsatisfiable: null, sql: step.sql, params: step.params, shapeJs: v1Shape(step.name, artifact.shapeJs), assumptions: artifact.assumptions };
}

// The model's function shape(data, input) is nested, not renamed: the inner
// declaration shadows the outer one, which the Crystal allowlist accepts.
function v1Shape(stepName: string, shapeJs: string | null): string | null {
  if (!shapeJs) return null;
  return `function shape(rows, input) {\n${shapeJs}\nreturn shape({ ${stepName}: rows }, input);\n}`;
}
