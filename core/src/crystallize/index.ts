// The @slime-cloud/core/crystallize entry (C10): the job, the check, and the helpers
// a host needs to load Crystal modules as data (manifest and module parsing). An app
// that imports its generated index.mjs never imports this entry, so acorn never loads
// there; Slime Cloud's runtime does import it, to parse modules it reads from storage.
export { checkCrystalFolder } from './check.js';
export { pinCrystalFolder } from './pin.js';
export { COST_TOLERANCE, verifyCrystalFolder, type VerifyOptions } from './verify.js';
export { parseCases, type CrystalCases } from './cases.js';
export { CrystalCodeError, checkShapeSource } from './allowlist.js';
export { DEFAULT_MIN_RUNS, crystallize, type CrystalOutcome, type CrystalReport, type CrystallizeOptions } from './crystallize.js';
export { MANIFEST_FILE, moduleFileFor, parseManifest, readManifest, type Manifest, type ManifestEntry } from './manifest.js';
export { parseModule, type CrystalCode } from './module-format.js';
export { SERVICES_FILE, renderServiceTypes, renderServices } from './services.js';
