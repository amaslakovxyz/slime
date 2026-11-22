// A Crystal as a plain function the app calls: its SQL (or its steps) through the app's
// sources, its shape in this process, then the output check. No engine, store or model (C10).
import { isApiStep } from '../../artifact/artifact.js';
import { DEFAULT_LIMITS } from '../../config/defaults.js';
import type { LimitOptions } from '../../config/options.js';
import { isStepsCrystal, type CrystalHandler } from '../../handler/crystal.js';
import type { InputValues } from '../../request/parse.js';
import { checkParamTypes } from '../../request/params.js';
import { SlimeError } from '../../shared/errors.js';
import { describeApiSource } from '../../sources/lifecycle.js';
import type { ApiSchema, ApiSource } from '../../sources/api/types.js';
import type { Connector } from '../../sources/sql/types.js';
import { isApiSource, type Source } from '../../sources/types.js';
import { runCrystal } from './run-crystal.js';

export interface CrystalServiceOptions {
  /** statementTimeoutMs, rowCap and the rest; unset ones keep the defaults. */
  limits?: Partial<LimitOptions>;
}

/** The SQL connector, or the app's sources by name (as in SlimeConfig), which a Crystal that calls API sources needs. */
export type CrystalSources = Connector | Readonly<Record<string, Source>>;

export type CrystalService = (sources: CrystalSources, input?: InputValues, options?: CrystalServiceOptions) => Promise<unknown>;

const STRING_SHAPE = 'a service needs the shape as a function: import it from the Crystal folder, not as source text';
const NO_SQL_SOURCE = 'a Crystal service needs the SQL connector: pass it, or the sources map that holds it';

export function crystalService(crystal: CrystalHandler): CrystalService {
  if (typeof crystal.shape === 'string') throw new TypeError(STRING_SHAPE);
  const apiSourceNames = isStepsCrystal(crystal) ? [...new Set(crystal.steps.filter(isApiStep).map(({ source }) => source))] : [];
  const schemas = new SchemaCache();
  return async (sources, input = {}, { limits: given } = {}) => {
    assertKnownInputs(crystal, input);
    checkParamTypes(crystal.paramTypes, input);
    const limits = { ...DEFAULT_LIMITS, ...given };
    const { connector, byName } = splitSources(sources);
    const apiSchemas = await schemas.forSources(apiSourceNames, byName, limits.apiTimeoutMs);
    return (await runCrystal({ connector, limits, sources: byName, apiSchemas }, crystal, input)).data;
  };
}

function isConnector(sources: CrystalSources): sources is Connector {
  return typeof (sources as Connector).run === 'function';
}

function splitSources(sources: CrystalSources): { connector: Connector; byName: Readonly<Record<string, Source>> } {
  if (isConnector(sources)) return { connector: sources, byName: {} };
  const connector = Object.values(sources).find((source): source is Connector => !isApiSource(source));
  if (!connector) throw new TypeError(NO_SQL_SOURCE);
  return { connector, byName: sources };
}

/** Each API source is described once per service, on its first call; a failed describe is tried again next call. */
class SchemaCache {
  readonly #schemas = new WeakMap<ApiSource, Promise<ApiSchema>>();

  async forSources(names: readonly string[], sources: Readonly<Record<string, Source>>, timeoutMs: number): Promise<Record<string, ApiSchema>> {
    const entries = await Promise.all(names.map(async (name) => [name, await this.#schema(name, sources[name], timeoutMs)] as const));
    return Object.fromEntries(entries);
  }

  #schema(name: string, source: Source | undefined, timeoutMs: number): Promise<ApiSchema> {
    if (!source || !isApiSource(source)) throw new SlimeError('INVALID_REQUEST', `This Crystal calls the API source "${name}": pass the app's sources, with "${name}" in them.`);
    const cached = this.#schemas.get(source);
    if (cached) return cached;
    const described = describeApiSource(name, source, timeoutMs);
    this.#schemas.set(source, described);
    described.catch(() => this.#schemas.delete(source));
    return described;
  }
}

// The request key fixes the input names; an unknown one is a caller's typo, not a filter (R5).
function assertKnownInputs({ paramTypes }: CrystalHandler, input: InputValues): void {
  const unknownNames = Object.keys(input).filter((name) => !(name in paramTypes));
  if (unknownNames.length === 0) return;
  throw new SlimeError('INVALID_REQUEST', `Unknown input ${unknownNames.join(', ')}; this Crystal takes ${Object.keys(paramTypes).join(', ') || 'no input'}.`);
}
