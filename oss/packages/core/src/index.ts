// The public entry. Deep imports are not part of the API; createSlime() arrives with M2.

export {
  SlimeConfig,
  DEFAULT_LIMITS,
  DEFAULT_TIERS,
  type CrystalRegistry,
  type ErrorEvent,
  type GeneratedEvent,
  type LimitOptions,
  type PromotedEvent,
  type ReviewedEvent,
  type SlimeEvent,
  type SlimeMode,
  type SlimeOptionOverrides,
  type SlimeOptions,
  type TierOptions,
  type WarningEvent,
} from './config.js';
export { SlimeConfigError, SlimeError, type ErrorCode, type SlimeErrorBody, type SlimeErrorOptions } from './errors.js';
export type {
  Artifact,
  ColumnInfo,
  Connector,
  ForeignKey,
  GenerationRequest,
  GenerationResult,
  Generator,
  ModelCallOptions,
  ModelUsage,
  ParamTypesForModel,
  QueryLimits,
  QueryPlan,
  ReviewRequest,
  ReviewResult,
  Reviewer,
  RunResult,
  SafetyReport,
  SandboxLimits,
  SandboxRunner,
  SchemaInfo,
  ShapeJob,
  TableInfo,
} from './ports.js';
export type { InputScalar, InputValue, InputValues, SlimeRequest } from './request/parse.js';
export type { ParamType } from './request/params.js';
export type { ObjectShape, Shape } from './request/shape.js';
export type { SlimeStore, StoreEntry } from './store/types.js';
