// The reference a Crystal is verified against: the Liquid handler it replaced and
// the inputs it was proven on. Written once by crystallize and pinned in
// manifest.json, so an edited module is always compared with the original, never
// with a reference rewritten to match it.
import type { Artifact, InputValues } from '@slime-cloud/core';

export const CASES_EXTENSION = '.cases.json';

export interface CrystalCases {
  /** The Liquid handler's code, as it ran when the Crystal was made. */
  liquid: Artifact;
  /** Recorded inputs of successful runs. */
  inputs: InputValues[];
}

export function casesFileFor(key: string): string {
  return `${key}${CASES_EXTENSION}`;
}

export function renderCases(cases: CrystalCases): string {
  return `${JSON.stringify(cases, null, 2)}\n`;
}

export function parseCases(json: string): CrystalCases {
  const cases = JSON.parse(json) as Partial<CrystalCases>;
  if (!cases.liquid || !Array.isArray(cases.liquid.steps) || !Array.isArray(cases.inputs)) throw new Error('not a Crystal cases file (liquid, inputs)');
  return cases as CrystalCases;
}
