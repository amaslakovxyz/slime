// The public entry. Deep imports are not part of the API; adapters have their own subpaths (C7).

export { createSlime } from './create-slime.js';
export { DEFAULT_STORE_DIR, fileStore } from './store/file-store.js';
export { memoryStore } from './store/memory-store.js';
export type {
  CacheOutcome,
  HandlerRecord,
  HandlerSummary,
  QueryMeta,
  QueryResult,
  QueryTimings,
  ReviewStatus,
  Slime,
  SlimeStats,
  StoredTier,
  Tier,
} from './engine/types.js';
export type { CrystalHandler, ShapeFunction } from './crystal/types.js';
export { handlerKeyFor, type HandlerProvenance } from './request/key.js';
export type { ParamTypes } from './request/params.js';

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
  OptimizeRequest,
  OptimizeResult,
  OptimizedCode,
  Optimizer,
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
