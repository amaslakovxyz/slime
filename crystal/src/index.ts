// @slime-cloud/crystal (C10): the crystallize job, the Crystal folder's format
// (manifest, modules, services, cases), and check / pin / verify. An app that
// imports its generated index.mjs or services.mjs never imports this package, so
// acorn never loads there; Slime Cloud's runtime does, to parse modules it reads from storage.
export { checkCrystalFolder } from './check.js';
export { pinCrystalFolder } from './pin.js';
export { COST_TOLERANCE, verifyCrystalFolder, type VerifyOptions } from './verify.js';
export { parseCases, type CrystalCases } from './cases.js';
export { CrystalCodeError, checkShapeSource } from './allowlist.js';
export { Crystallizer, DEFAULT_PRUNE_DAYS, type CrystallizeRun, type CrystallizerOptions, type PruneOptions } from './crystallizer.js';
export { DEFAULT_MIN_RUNS, crystallize, type CrystalOutcome, type CrystalReport, type CrystallizeOptions } from './crystallize.js';
export { MANIFEST_FILE, moduleFileFor, parseManifest, readManifest, type Manifest, type ManifestEntry } from './manifest.js';
export { parseModule, type CrystalCode } from './module-format.js';
export { SERVICES_FILE, renderServiceTypes, renderServices } from './services.js';
