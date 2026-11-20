// Public entry of @slime-cloud/core. Everything an app may import is
// re-exported from here; deep imports are not part of the API.
// createSlime() and slime.query() arrive with M2 (PLAN.md §7).

export {
  SlimeConfig,
  DEFAULT_LIMITS,
  DEFAULT_TIERS,
  type CrystalRegistry,
  type LimitOptions,
  type SlimeEvent,
  type SlimeOptions,
  type TierOptions,
} from './config.js';
export { SlimeConfigError, SlimeError, type ErrorCode } from './errors.js';
export type {
  Artifact,
  ColumnInfo,
  Connector,
  GenerationRequest,
  GenerationResult,
  Generator,
  ReviewRequest,
  ReviewResult,
  Reviewer,
  RunResult,
  SafetyReport,
  SandboxLimits,
  SandboxRunner,
  SchemaInfo,
  TableInfo,
} from './ports.js';
export type { InputScalar, InputValue, SlimeRequest } from './request/parse.js';
export type { ParamType } from './request/params.js';
export type { Shape } from './request/shape.js';
export type { BuiltInStore, SlimeStore, StoreEntry, StoreOption } from './store/types.js';
