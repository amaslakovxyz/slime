import { isNonEmptyString, isPlainObject } from '../guards.js';
import { numberProblems } from './number-rules.js';

const OPTION_KEYS = ['connector', 'generator', 'reviewer', 'store', 'crystal', 'glossary', 'rules', 'tiers', 'limits', 'onEvent'];
const CONNECTOR_METHODS = ['describe', 'check', 'run', 'safetyCheck', 'close'];
const GENERATOR_METHODS = ['generate'];
const GENERATOR_STRINGS = ['model', 'promptHash'];
const REVIEWER_METHODS = ['review'];
const REVIEWER_STRINGS = ['model'];
const STORE_METHODS = ['get', 'put', 'list', 'delete'];

const NOT_AN_OBJECT = 'the config must be an object, for example new SlimeConfig({ connector })';
const CONNECTOR_REQUIRED = 'connector is required: it tells Slime where the data comes from';
const REVIEWER_WITHOUT_GENERATOR = 'reviewer is set but generator is not: without a generator (locked mode) nothing is ever reviewed';

/** Every problem at once, so the app fixes its config in one pass (C4). */
export function configProblems(options: unknown): string[] {
  if (!isPlainObject(options)) return [NOT_AN_OBJECT];
  return [
    ...unknownOptionProblems(options),
    ...connectorProblems(options.connector),
    ...generatorProblems(options.generator),
    ...reviewerProblems(options.reviewer, options.generator !== undefined),
    ...storeProblems(options.store),
    ...crystalProblems(options.crystal),
    ...glossaryProblems(options.glossary),
    ...rulesProblems(options.rules),
    ...numberProblems('tiers', options.tiers),
    ...numberProblems('limits', options.limits),
    ...onEventProblems(options.onEvent),
  ];
}

function unknownOptionProblems(options: Record<string, unknown>): string[] {
  const unknownKeys = Object.keys(options).filter((key) => !OPTION_KEYS.includes(key));
  if (unknownKeys.length === 0) return [];
  const plural = unknownKeys.length > 1 ? 's' : '';
  return [`unknown option${plural} ${unknownKeys.join(', ')} (allowed: ${OPTION_KEYS.join(', ')})`];
}

function connectorProblems(connector: unknown): string[] {
  if (connector === undefined) return [CONNECTOR_REQUIRED];
  return missingMethods('connector', connector, CONNECTOR_METHODS);
}

function generatorProblems(generator: unknown): string[] {
  if (generator === undefined) return [];
  return [...missingMethods('generator', generator, GENERATOR_METHODS), ...missingStrings('generator', generator, GENERATOR_STRINGS)];
}

function reviewerProblems(reviewer: unknown, hasGenerator: boolean): string[] {
  if (reviewer === undefined) return [];
  const problems = [...missingMethods('reviewer', reviewer, REVIEWER_METHODS), ...missingStrings('reviewer', reviewer, REVIEWER_STRINGS)];
  if (!hasGenerator) problems.push(REVIEWER_WITHOUT_GENERATOR);
  return problems;
}

function storeProblems(store: unknown): string[] {
  return store === undefined ? [] : missingMethods('store', store, STORE_METHODS);
}

function crystalProblems(crystal: unknown): string[] {
  const isValid = crystal === undefined || crystal === false || isPlainObject(crystal);
  return isValid ? [] : ['crystal must be the imported Crystal registry, or false'];
}

function glossaryProblems(glossary: unknown): string[] {
  if (glossary === undefined) return [];
  if (!isPlainObject(glossary)) return ['glossary must be an object of { word: "what it means" }'];
  return Object.entries(glossary)
    .filter(([word, meaning]) => !word.trim() || !isNonEmptyString(meaning))
    .map(([word]) => `glossary.${word || '""'} must be a non-empty description`);
}

function rulesProblems(rules: unknown): string[] {
  const isValid = rules === undefined || (Array.isArray(rules) && rules.every(isNonEmptyString));
  return isValid ? [] : ['rules must be a list of non-empty strings'];
}

function onEventProblems(onEvent: unknown): string[] {
  return onEvent === undefined || typeof onEvent === 'function' ? [] : ['onEvent must be a function'];
}

function missingMethods(optionName: string, value: unknown, methods: readonly string[]): string[] {
  if (!value || typeof value !== 'object') return [`${optionName} must be an object with ${methods.join(', ')}`];
  const fields = value as Record<string, unknown>;
  const missing = methods.filter((method) => typeof fields[method] !== 'function');
  if (missing.length === 0) return [];
  return [`${optionName} is missing ${missing.length > 1 ? 'methods' : 'method'} ${missing.join(', ')}`];
}

function missingStrings(optionName: string, value: unknown, keys: readonly string[]): string[] {
  if (!value || typeof value !== 'object') return [];
  const fields = value as Record<string, unknown>;
  return keys.filter((key) => !isNonEmptyString(fields[key])).map((key) => `${optionName}.${key} must be a non-empty string`);
}
