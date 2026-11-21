// The @slime-cloud/core/crystallize entry (C10): the job and the check. The
// runtime never imports it, so acorn never loads in a serving process.
export { checkCrystalFolder } from './check.js';
export { CrystalCodeError, checkShapeSource } from './allowlist.js';
export { DEFAULT_MIN_RUNS, crystallize, type CrystalOutcome, type CrystalReport, type CrystallizeOptions } from './crystallize.js';
export type { Manifest, ManifestEntry } from './manifest.js';
